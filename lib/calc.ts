export type Ev = { ts: number; rate: number }; // ts in ms, rate = decimal per funding event
const DAY = 86400000;
const dayKey = (ts: number) => Math.floor(ts / DAY);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function bucket(ev: Ev[]) {
  const m = new Map<number, number>();
  for (const e of ev) m.set(dayKey(e.ts), (m.get(dayKey(e.ts)) ?? 0) + e.rate);
  return m;
}

/** Per-UTC-day funding as percentages, retaining days present on only one exchange. */
export function dailyFunding(b: Ev[], d: Ev[], direction: string) {
  const bm = bucket(b), dm = bucket(d);
  const sign = direction === DIR_B || direction === BYBIT_DIR_B ? -1 : 1;
  const days = [...new Set([...bm.keys(), ...dm.keys()])].sort((x, y) => x - y);
  return days.map((k) => ({
    date: new Date(k * DAY).toISOString().slice(0, 10),
    binance: bm.has(k) ? bm.get(k)! * 100 : null,
    peer: dm.has(k) ? dm.get(k)! * 100 : null,
    net: bm.has(k) && dm.has(k) ? (bm.get(k)! - dm.get(k)!) * sign * 100 : null,
  }));
}

/** Per-UTC-day funding for each exchange. Only days present on BOTH sides, excluding today (incomplete). */
export function dailySpread(b: Ev[], d: Ev[]) {
  const bm = bucket(b), dm = bucket(d), today = dayKey(Date.now());
  let days = [...bm.keys()].filter((k) => dm.has(k) && k < today).sort((x, y) => x - y);
  if (days.length >= 8) days = days.slice(1); // first day of window is usually partial
  return days.map((k) => ({ day: k * DAY, b: bm.get(k)!, d: dm.get(k)!, spread: bm.get(k)! - dm.get(k)! }));
}

export const DIR_A = "SHORT_BINANCE_LONG_DELTA";
export const DIR_B = "LONG_BINANCE_SHORT_DELTA";
export const BYBIT_DIR_A = "SHORT_BINANCE_LONG_BYBIT";
export const BYBIT_DIR_B = "LONG_BINANCE_SHORT_BYBIT";

/** Short the exchange paying less, long the other. Positive funding: longs pay shorts.
 *  Short Binance + Long Delta earns (binanceFunding - deltaFunding).
 *  Direction is chosen from the last 30 days; longer-window returns hold that same direction. */
export function analyze(b: Ev[], d: Ev[], roundTripFee: number, directions = [DIR_A, DIR_B]) {
  const rows = dailySpread(b, d);
  if (rows.length < 3) return null;
  const recent = rows.slice(-30);
  const sign = sum(recent.map((r) => r.spread)) >= 0 ? 1 : -1;
  const all = rows.map((r) => r.spread * sign);
  const s = all.slice(-30);
  const n = s.length;
  const avg = sum(s) / n;
  const std = Math.sqrt(sum(s.map((x) => (x - avg) ** 2)) / n);
  let flips = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1].spread, c = recent[i].spread;
    if (a !== 0 && c !== 0 && Math.sign(a) !== Math.sign(c)) flips++;
  }
  const last3 = s.slice(-3);
  const last90 = all.slice(-90);
  const last365 = all.slice(-365);
  return {
    direction: sign === 1 ? directions[0] : directions[1],
    days: n,
    days90: last90.length,
    days365: last365.length,
    ret30: sum(s),
    ret7: sum(s.slice(-7)),
    ret90: sum(last90),
    ret365: sum(last365),
    net30: sum(s) - roundTripFee,
    net90: sum(last90) - roundTripFee,
    net365: sum(last365) - roundTripFee,
    avg_daily: avg,
    apr: avg * 365,
    trend3_apr: (sum(last3) / last3.length) * 365,
    consistency: s.filter((x) => x > 0).length / n,
    spread_std: std,
    sign_flips: flips,
    breakeven_days: avg > 0 ? roundTripFee / avg : null,
  };
}

export function chartSeries(b: Ev[], d: Ev[], direction: string, labels = ["binance", "delta"]) {
  const sign = direction === DIR_B || direction === BYBIT_DIR_B ? -1 : 1;
  let cum = 0;
  return dailySpread(b, d).map((r) => {
    const earn = r.spread * sign;
    cum += earn;
    return {
      date: new Date(r.day).toISOString().slice(0, 10),
      [labels[0]]: r.b * 100, [labels[1]]: r.d * 100, // % per day
      earn: earn * 100, cumulative: cum * 100,
    };
  });
}

/** Funding as a decimal per day, regardless of interval. */
export const perDay = (rate: number | null, intervalH: number | null) =>
  rate == null || !intervalH ? null : (rate * 24) / intervalH;

// ======================= Dynamic flip (direction changes automatically) =======================
export type DynResult = {
  start: string; direction: string; days: number;
  flips: number; flips30: number; flips90: number;
  ret7: number; ret30: number; ret90: number; ret365: number;   // funding earned, gross, as decimals of one leg's notional
  net30: number; net90: number; net365: number;                 // minus entry+exit fees once, and one round-trip fee per flip in the window
  grossAll: number;      // funding earned over the whole overlap with flipping, before fees
  fixedGross: number;    // same period, never flipping (stays on the starting side)
  flipsAll: number; streakNow: number; lastFlipTs: number | null;
  daily: { date: string; earn: number; fixed: number; cumulative: number; direction: string }[];
  flipLog: { ts: number; date: string; direction: string; streak: number }[];
};

/** Round-trip fee (4 fills) for a Binance <-> peer hedge. Same defaults as the rest of the app. */
export const roundTripFeeFor = (peer: "delta" | "bybit") =>
  2 * (Number(process.env.TAKER_FEE_BINANCE ?? 0.0005) + Number(peer === "bybit" ? process.env.TAKER_FEE_BYBIT ?? 0.00055 : process.env.TAKER_FEE_DELTA ?? 0.0005));

/**
 * Replays every funding payment of both exchanges and flips the hedge when it starts losing.
 *  - START: Short Binance / Long peer (set FLIP_START=B for the opposite). The first 'direction' is NOT chosen from hindsight.
 *  - The net of the CURRENT direction is measured in blocks of FLIP_BLOCK_HOURS (default 8).
 *    A block that nets negative (we pay) adds to a losing streak. A block that nets zero or positive resets the streak to 0.
 *  - When the losing streak reaches -FLIP_THRESHOLD (default 0.0025 = 0.25% of notional), swap long and short and restart at 0.
 *    Earlier profits do not count, and the flip takes effect from the next payment.
 * Each flip costs one round-trip fee (close 2 legs + open 2 legs). Entry and exit cost one more.
 * Only the period where BOTH exchanges have history is used. Returns are on one leg's notional.
 */
export function dynamicFlip(b: Ev[], d: Ev[], roundTripFee: number, dirs: [string, string] = [DIR_A, DIR_B],
  opts: { threshold?: number; blockHours?: number; start?: "A" | "B" } = {}): DynResult | null {
  const threshold = opts.threshold ?? Number(process.env.FLIP_THRESHOLD ?? 0.0025);
  const blockMs = (opts.blockHours ?? Number(process.env.FLIP_BLOCK_HOURS ?? 8)) * 3600000;
  const startSign = (opts.start ?? process.env.FLIP_START ?? "A") === "B" ? -1 : 1;
  if (!b.length || !d.length) return null;
  const t0 = Math.max(b[0].ts, d[0].ts), t1 = Math.min(b[b.length - 1].ts, d[d.length - 1].ts);
  if (t1 - t0 < 3 * DAY) return null;

  // One value per timestamp: what the STARTING roles earn (short Binance receives its rate, long peer pays its rate).
  const base = new Map<number, number>();
  for (const e of b) if (e.ts >= t0 && e.ts <= t1) base.set(e.ts, (base.get(e.ts) ?? 0) + e.rate);
  for (const e of d) if (e.ts >= t0 && e.ts <= t1) base.set(e.ts, (base.get(e.ts) ?? 0) - e.rate);

  let dir = startSign, streak = 0, bucket: number | null = null, bucketSum = 0, bucketLast = 0;
  const earns: { ts: number; earn: number; fixed: number; dir: number }[] = [];
  const flips: { ts: number; dir: number; streak: number }[] = [];
  for (const ts of [...base.keys()].sort((x, y) => x - y)) {
    const bk = Math.floor(ts / blockMs);
    if (bucket !== null && bk !== bucket) {                    // the previous block is complete
      streak = bucketSum < 0 ? streak + bucketSum : 0;
      bucketSum = 0;
      if (streak < -threshold) { dir = -dir; flips.push({ ts: bucketLast, dir, streak }); streak = 0; }
    }
    bucket = bk;
    const earn = dir * base.get(ts)!;                          // earned by the position held at this payment
    earns.push({ ts, earn, fixed: startSign * base.get(ts)!, dir });
    bucketSum += earn; bucketLast = ts;
  }

  const within = (n: number) => t1 - n * DAY;
  const gross = (n: number) => sum(earns.filter((e) => e.ts > within(n)).map((e) => e.earn));
  const nFlips = (n: number) => flips.filter((f) => f.ts > within(n)).length;
  const net = (n: number) => gross(n) - roundTripFee * (1 + nFlips(n));
  const names = (x: number) => (x === 1 ? dirs[0] : dirs[1]);

  const perDay = new Map<number, { earn: number; fixed: number; dir: number }>();
  for (const e of earns) { const k = dayKey(e.ts), c = perDay.get(k) ?? { earn: 0, fixed: 0, dir: e.dir }; perDay.set(k, { earn: c.earn + e.earn, fixed: c.fixed + e.fixed, dir: e.dir }); }
  let cum = 0;
  const daily = [...perDay.keys()].sort((x, y) => x - y).map((k) => {
    const v = perDay.get(k)!; cum += v.earn;
    return { date: new Date(k * DAY).toISOString().slice(0, 10), earn: v.earn, fixed: v.fixed, cumulative: cum, direction: names(v.dir) };
  });
  return {
    start: names(startSign), direction: names(dir), days: Math.round((t1 - t0) / DAY),
    flips: nFlips(365), flips30: nFlips(30), flips90: nFlips(90),
    ret7: gross(7), ret30: gross(30), ret90: gross(90), ret365: gross(365),
    net30: net(30), net90: net(90), net365: net(365),
    grossAll: sum(earns.map((e) => e.earn)), fixedGross: sum(earns.map((e) => e.fixed)),
    flipsAll: flips.length, streakNow: bucketSum < 0 ? streak + bucketSum : 0, lastFlipTs: flips.length ? flips[flips.length - 1].ts : null,
    daily,
    flipLog: flips.map((f) => ({ ts: f.ts, date: new Date(f.ts).toISOString().slice(0, 16).replace("T", " "), direction: names(f.dir), streak: f.streak })),
  };
}