import { q } from "./db";
import { BYBIT_DIR_A, BYBIT_DIR_B, DIR_A, DIR_B, dynamicFlip, type Ev } from "./calc";

/**
 * Recommendation for the "flip sides automatically" strategy.
 * For every pair it answers: should this pair be traded with a FIXED side, with the DYNAMIC (flipping) side, or avoided?
 * It replays the real flip rule from lib/calc.ts over the real funding payments, so what is tested is what is traded.
 */
export type DynMarket = "delta" | "bybit";

const DAY = 86400000;
export const DYN = {
  HORIZON: 120,        // days a position is held in each test window
  STEP: 10,            // a new test window starts every 10 days (windows overlap, so treat results as a rough check)
  PRIOR: 30,           // each window starts on the side that the previous 30 days favoured (no hindsight)
  SHRINK: 0.8,         // assume 20% of the historical edge gets competed away (same as the fixed ranking)
  MIN_DAYS: 170,       // overlapping days of history needed
  MIN_WINDOWS: 5,
  MIN_CHANGES: 3,      // funding regime changes in the last 180 days. Fewer means one side nearly always wins: use fixed
  MIN_RUN_DAYS: 4,     // average regime length. Shorter means the sign flips too fast for the rule to keep up
  MAX_CONCENTRATION: 0.6,   // share of the gain over fixed that may come from the best 3 months
  MIN_HEADROOM: 3,     // break-even cost per flip must be at least 3x the real cost of a flip
  MIN_ROBUST: 0.75,    // share of rule settings (threshold x block length) that must still be profitable
  MIN_WIN: 0.7,        // share of test windows that must be profitable after costs
  MAX_LEV: Number(process.env.DYN_MAX_LEVERAGE ?? 3), // flips move the short between exchanges, so keep leverage lower than for a fixed side
};
const GRID_THRESHOLDS = [0.0015, 0.0025, 0.005, 0.01];
const GRID_BLOCKS = [4, 8, 24];
export const dynTable = (m: DynMarket) => (m === "bybit" ? "bybit_pair_dyn_features" : "pair_dyn_features");

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const nn = (a: (number | null)[]) => a.filter((x): x is number => x !== null);
const rounded = (v: number) => Math.round(v * 1e6) / 1e6;
const slip = (vol: number | null) => (vol == null ? 0.002 : vol >= 1e8 ? 0.0001 : vol >= 1e7 ? 0.0003 : vol >= 1e6 ? 0.0008 : 0.002);
const quantile = (sorted: number[], p: number) => sorted[Math.floor(p * (sorted.length - 1))];

function autocorr(x: number[], lag: number) {
  if (x.length <= lag + 5) return null;
  const m = mean(x); let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) { den += (x[i] - m) ** 2; if (i >= lag) num += (x[i] - m) * (x[i - lag] - m); }
  return den ? num / den : null;
}
function pearson(x: number[], y: number[]) {
  const mx = mean(x), my = mean(y); let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx && dy ? n / Math.sqrt(dx * dy) : null;
}

/** Raw funding payments for a set of bases, Binance and the peer, about the last year. */
export async function loadEvents(bases: string[], peer: string) {
  const rows = await q(
    `SELECT base, exchange, ts, rate FROM funding_history
      WHERE base = ANY($1::text[]) AND exchange IN ('binance', $2) AND ts > now() - interval '370 days'
      ORDER BY base, ts`, [bases, peer]);
  const out = new Map<string, { b: Ev[]; d: Ev[] }>();
  for (const r of rows) {
    let e = out.get(r.base); if (!e) { e = { b: [], d: [] }; out.set(r.base, e); }
    (r.exchange === "binance" ? e.b : e.d).push({ ts: new Date(r.ts).getTime(), rate: Number(r.rate) });
  }
  return out;
}

/** One value per UTC day: Binance funding minus peer funding (what Short Binance / Long peer earns). Index 364 = yesterday. */
function dailyNet(b: Ev[], d: Ev[]) {
  const bm = new Map<number, number>(), dm = new Map<number, number>();
  for (const e of b) { const k = Math.floor(e.ts / DAY); bm.set(k, (bm.get(k) ?? 0) + e.rate); }
  for (const e of d) { const k = Math.floor(e.ts / DAY); dm.set(k, (dm.get(k) ?? 0) + e.rate); }
  const today = Math.floor(Date.now() / DAY), N = 365;
  const arr: (number | null)[] = Array(N).fill(null);
  for (const [k, v] of bm) {
    if (!dm.has(k) || k >= today) continue;
    const i = k - (today - N);
    if (i >= 0 && i < N) arr[i] = v - dm.get(k)!;
  }
  return arr;
}

/** How often does the spread change sign? Uses 3-day sums so single noisy days do not count as a regime change. */
function regimes(daily: number[]) {
  const sm: number[] = [];
  for (let i = 2; i < daily.length; i++) sm.push(daily[i] + daily[i - 1] + daily[i - 2]);
  let changes = 0, last = 0;
  for (const x of sm) { const s = Math.sign(x); if (s !== 0) { if (last !== 0 && s !== last) changes++; last = s; } }
  return { changes, avgRun: sm.length / (changes + 1) };
}

export function analyzeDynamic(base: string, b: Ev[], d: Ev[],
  o: { market: DynMarket; fee: number; volume: number | null; basis: number | null; maxMove: number | null }) {
  const dirs: [string, string] = o.market === "bybit" ? [BYBIT_DIR_A, BYBIT_DIR_B] : [DIR_A, DIR_B];
  const cost = o.fee + 4 * slip(o.volume);               // one flip (or one entry plus exit): 4 fills plus slippage
  const arr = dailyNet(b, d), last180 = nn(arr.slice(-180));
  const full = dynamicFlip(b, d, cost, dirs);
  const stop = (why: string) => ({ base, market: o.market, mode: "avoid", eligible: false, reasons: [why], flags: [] as string[], days: full?.days ?? 0 });
  if (!full || last180.length < DYN.MIN_DAYS) return stop("Less than about 170 days of overlapping history");

  // 1) Regime behaviour
  const { changes, avgRun } = regimes(last180);
  const ac1 = autocorr(last180, 1), ac7 = autocorr(last180, 7);

  // 2) Rolling test windows: choose the start side from the previous 30 days only, then replay the flip rule for 120 days.
  const t0 = Math.max(b[0].ts, d[0].ts), t1 = Math.min(b[b.length - 1].ts, d[d.length - 1].ts);
  const inRange = (x: Ev[], a: number, z: number) => x.filter((e) => e.ts >= a && e.ts < z);
  const dyn: number[] = [], fix: number[] = [], flipCounts: number[] = [];
  for (let s = t0 + DYN.PRIOR * DAY; s + DYN.HORIZON * DAY <= t1; s += DYN.STEP * DAY) {
    const pb = inRange(b, s - DYN.PRIOR * DAY, s), pd = inRange(d, s - DYN.PRIOR * DAY, s);
    if (pb.length < 20 || pd.length < 20) continue;
    const sign = sum(pb.map((e) => e.rate)) - sum(pd.map((e) => e.rate)) >= 0 ? 1 : -1;
    const r = dynamicFlip(inRange(b, s, s + DYN.HORIZON * DAY), inRange(d, s, s + DYN.HORIZON * DAY), cost, dirs, { start: sign === 1 ? "A" : "B" });
    if (!r) continue;
    dyn.push(r.grossAll * DYN.SHRINK - cost * (1 + r.flipsAll));
    fix.push(r.fixedGross * DYN.SHRINK - cost);
    flipCounts.push(r.flipsAll);
  }
  if (dyn.length < DYN.MIN_WINDOWS) return stop("Not enough history for the rolling test (about 200+ days needed)");
  const ds = [...dyn].sort((x, y) => x - y), fs = [...fix].sort((x, y) => x - y);
  const p10 = quantile(ds, 0.1), p50 = quantile(ds, 0.5), p90 = quantile(ds, 0.9);
  const pWin = dyn.filter((x) => x > 0).length / dyn.length;
  const beat = dyn.filter((x, i) => x > fix[i]).length / dyn.length;
  const fixedP50 = quantile(fs, 0.5), fixedP10 = quantile(fs, 0.1);

  // 3) Whole-history replay: is the gain over a fixed side concentrated, and how much room is there above the flip cost?
  const gains: number[] = [];
  for (let i = 0; i < full.daily.length; i += 30) gains.push(sum(full.daily.slice(i, i + 30).map((x) => x.earn - x.fixed)));
  const totalGain = full.grossAll - full.fixedGross;
  const top3 = sum([...gains].sort((x, y) => y - x).slice(0, 3).filter((x) => x > 0));
  const concentration = totalGain > 0 ? Math.min(1, top3 / totalGain) : 1;
  const breakEven = full.flipsAll > 0 ? totalGain / full.flipsAll : null;   // cost per flip at which flipping stops beating a fixed side
  const headroom = breakEven == null ? null : breakEven / cost;
  const avgStreak = full.flipLog.length ? mean(full.flipLog.map((f) => -f.streak)) : null;

  // 4) Robustness: does it still work with other thresholds and block lengths?
  let robust = 0, robustTotal = 0;
  for (const th of GRID_THRESHOLDS) for (const bh of GRID_BLOCKS) {
    const r = dynamicFlip(b, d, cost, dirs, { threshold: th, blockHours: bh });
    if (!r) continue;
    robustTotal++;
    if (r.grossAll * DYN.SHRINK - cost * (1 + r.flipsAll) > 0) robust++;
  }

  // 5) Leverage and capital return (same margin rule as the fixed ranking, capped lower)
  const lev = o.maxMove == null ? 1 : Math.max(1, Math.min(DYN.MAX_LEV, Math.floor(1 / (o.maxMove * 1.2 + 0.005))));
  const retCap = p50 * (365 / DYN.HORIZON) * (lev / 2);

  // 6) Decide
  const reasons: string[] = [], flags: string[] = [];
  if (changes < DYN.MIN_CHANGES) reasons.push(`Only ${changes} funding regime change${changes === 1 ? "" : "s"} in 180 days`);
  if (avgRun < DYN.MIN_RUN_DAYS) reasons.push(`Spread changes sign too fast (regimes last about ${avgRun.toFixed(1)} days)`);
  if (concentration > DYN.MAX_CONCENTRATION) reasons.push(`${Math.round(concentration * 100)}% of the gain over fixed comes from 3 months`);
  if (headroom == null || headroom < DYN.MIN_HEADROOM) reasons.push(headroom == null ? "The rule never flipped, so there is nothing to test" : `Break-even per flip is only ${headroom.toFixed(1)}x the real flip cost`);
  if (robustTotal === 0 || robust / robustTotal < DYN.MIN_ROBUST) reasons.push(`Profitable in only ${robust} of ${robustTotal} rule settings`);
  if (pWin < DYN.MIN_WIN) reasons.push(`Profitable after costs in only ${Math.round(pWin * 100)}% of test windows`);
  if (p50 <= 0) reasons.push("Typical return after costs is not positive");
  if (p50 <= fixedP50) reasons.push("Does not beat staying on a fixed side");
  // No volume filter: thin pairs are never excluded. They only get a warning, and slippage is already in the cost estimate.
  if (o.volume != null && o.volume < 1e6) flags.push("Very thin liquidity");
  if (o.basis != null && Math.abs(o.basis) > 0.005) flags.push("Wide price gap between exchanges");
  if (o.volume == null) flags.push("No volume data");
  if (o.maxMove == null) flags.push("No price history for margin check");
  if (full.streakNow < -0.5 * 0.0025) flags.push("A losing streak is building now");

  const stable = changes < DYN.MIN_CHANGES;
  const mode = reasons.length === 0 ? "dynamic" : stable && avgRun >= DYN.MIN_RUN_DAYS ? "fixed" : "avoid";
  const why = mode === "fixed" ? [`One side nearly always wins (${changes} regime change${changes === 1 ? "" : "s"} in 180 days): use the fixed-side list`] : reasons;
  return {
    base, market: o.market, mode, eligible: mode === "dynamic", reasons: why, flags,
    days: full.days, regime_changes: changes, avg_run: avgRun, ac1, ac7,
    direction_now: full.direction, flips_all: full.flipsAll, flips_30d: (full.flipsAll / Math.max(1, full.days)) * 30,
    last_flip: full.lastFlipTs ? new Date(full.lastFlipTs).toISOString().slice(0, 10) : null,
    days_since_flip: full.lastFlipTs ? Math.floor((Date.now() - full.lastFlipTs) / DAY) : null,
    streak_now: full.streakNow, avg_streak_at_flip: avgStreak,
    p10, p50, p90, p_win: pWin, beat_fixed: beat, fixed_p10: fixedP10, fixed_p50: fixedP50, windows: dyn.length,
    avg_flips_window: mean(flipCounts), break_even: breakEven, cost, headroom, concentration, robust, robust_total: robustTotal,
    volume: o.volume, basis: o.basis, max_move: o.maxMove, lev, ret_cap: retCap,
    series: arr.slice(-180).map((x) => (x === null ? null : rounded(x))),
  };
}

// ---- Read side ----
function corr(a: (number | null)[], b: (number | null)[]) {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null) { x.push(a[i]!); y.push(b[i]!); }
  return x.length >= 60 ? pearson(x, y) : null;
}

export async function getDynamicRecommendations(market: DynMarket) {
  let rows: any[];
  try { rows = await q(`SELECT data, updated_at FROM ${dynTable(market)}`); }
  catch (e: any) { if (/does not exist/i.test(String(e?.message))) return null; throw e; }
  if (!rows.length) return null;
  const all = rows.map((r: any) => ({ ...r.data, updated_at: r.updated_at }));
  const picks = all.filter((x: any) => x.mode === "dynamic").sort((a: any, b: any) => b.p50 - a.p50);
  // Diversified basket: best typical return first, skip pairs whose daily spread moves with one already chosen.
  const basket: any[] = [];
  for (const c of picks) {
    if (basket.length >= 8) break;
    if (basket.every((x) => { const k = corr(c.series, x.series); return k == null || k < 0.6; })) basket.push(c);
  }
  const strip = ({ series, ...rest }: any) => rest;
  return {
    basket: basket.map((x) => x.base),
    picks: picks.map(strip),
    others: all.filter((x: any) => x.mode !== "dynamic").map(strip),
    counts: { dynamic: picks.length, fixed: all.filter((x: any) => x.mode === "fixed").length, avoid: all.filter((x: any) => x.mode === "avoid").length },
    as_of: rows.reduce((m: any, r: any) => (r.updated_at > m ? r.updated_at : m), rows[0].updated_at),
    settings: { horizon: DYN.HORIZON, shrink: DYN.SHRINK, threshold: Number(process.env.FLIP_THRESHOLD ?? 0.0025), blockHours: Number(process.env.FLIP_BLOCK_HOURS ?? 8), maxLeverage: DYN.MAX_LEV },
  };
}