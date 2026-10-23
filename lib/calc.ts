export type Ev = { ts: number; rate: number }; // ts in ms, rate = decimal per funding event
const DAY = 86400000;
const dayKey = (ts: number) => Math.floor(ts / DAY);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function bucket(ev: Ev[]) {
  const m = new Map<number, number>();
  for (const e of ev) m.set(dayKey(e.ts), (m.get(dayKey(e.ts)) ?? 0) + e.rate);
  return m;
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

/** Short the exchange paying less, long the other. Positive funding: longs pay shorts.
 *  Short Binance + Long Delta earns (binanceFunding - deltaFunding).
 *  Direction is chosen from the last 30 days; the 90-day figure holds that same direction. */
export function analyze(b: Ev[], d: Ev[], roundTripFee: number) {
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
  return {
    direction: sign === 1 ? DIR_A : DIR_B,
    days: n,
    days90: all.length,
    ret30: sum(s),
    ret7: sum(s.slice(-7)),
    ret90: sum(all),
    net30: sum(s) - roundTripFee,
    net90: sum(all) - roundTripFee,
    avg_daily: avg,
    apr: avg * 365,
    trend3_apr: (sum(last3) / last3.length) * 365,
    consistency: s.filter((x) => x > 0).length / n,
    spread_std: std,
    sign_flips: flips,
    breakeven_days: avg > 0 ? roundTripFee / avg : null,
  };
}

export function chartSeries(b: Ev[], d: Ev[], direction: string) {
  const sign = direction === DIR_B ? -1 : 1;
  let cum = 0;
  return dailySpread(b, d).map((r) => {
    const earn = r.spread * sign;
    cum += earn;
    return {
      date: new Date(r.day).toISOString().slice(5, 10),
      binance: r.b * 100, delta: r.d * 100, // % per day
      earn: earn * 100, cumulative: cum * 100,
    };
  });
}

/** Funding as a decimal per day, regardless of interval. */
export const perDay = (rate: number | null, intervalH: number | null) =>
  rate == null || !intervalH ? null : (rate * 24) / intervalH;