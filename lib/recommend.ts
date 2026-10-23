import { q } from "./db";
import { binanceWorstMove } from "./exchanges";

// ---- Settings ----
export const LOOKBACK = 90;   // days of history used to judge a pair
export const HORIZON = 120;   // holding period being forecast (4 months)
const MIN_RECENT = 170;       // need ~180 days of overlapping history
const SHRINK = 0.8;           // assume 20% of the historical edge gets competed away
const BLOCK = 7;              // bootstrap block length (days)
const SIMS = 500;
const N = 365;
const DAYMS = 86400000;
const DIR_A = "SHORT_BINANCE_LONG_DELTA", DIR_B = "LONG_BINANCE_SHORT_DELTA";

// ---- Small helpers ----
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nn = (a: (number | null)[]) => a.filter((x): x is number => x !== null);
const roundTripFee = () => 2 * (Number(process.env.TAKER_FEE_BINANCE ?? 0.0005) + Number(process.env.TAKER_FEE_DELTA ?? 0.0005));
const slipPerLeg = (vol: number | null) => (vol == null ? 0.002 : vol >= 1e8 ? 0.0001 : vol >= 1e7 ? 0.0003 : vol >= 1e6 ? 0.0008 : 0.002);
const minVolume = () => Number(process.env.REC_MIN_VOLUME_USD ?? 1e6);
const rounded = (v: number) => Math.round(v * 1e6) / 1e6;

function rng(seed: number) { // deterministic, so results don't change between runs on the same data
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

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
function ranks(a: number[]) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r: number[] = Array(a.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

// ---- Data: one value per UTC day (Binance funding minus Delta funding), aligned so index N-1 = yesterday ----
export async function loadDaily(bases: string[]) {
  const rows = await q(
    `SELECT base, exchange, FLOOR(EXTRACT(EPOCH FROM ts)/86400)::int AS d, SUM(rate) AS r
       FROM funding_history WHERE base = ANY($1::text[]) GROUP BY 1,2,3`, [bases]);
  const t = Math.floor(Date.now() / DAYMS);
  const by = new Map<string, { b: Map<number, number>; d: Map<number, number> }>();
  for (const r of rows) {
    let e = by.get(r.base); if (!e) { e = { b: new Map(), d: new Map() }; by.set(r.base, e); }
    (r.exchange === "binance" ? e.b : e.d).set(Number(r.d), Number(r.r));
  }
  const out = new Map<string, (number | null)[]>();
  for (const [base, e] of by) {
    const common = [...e.b.keys()].filter((k) => e.d.has(k) && k < t).sort((a, b) => a - b);
    const first = common.length >= 8 ? common[0] : -1; // first day of a window is usually partial
    const arr: (number | null)[] = Array(N).fill(null);
    for (const k of common) { if (k === first) continue; const i = k - (t - N); if (i >= 0 && i < N) arr[i] = e.b.get(k)! - e.d.get(k)!; }
    out.set(base, arr);
  }
  return out;
}

// ---- Per-pair analysis ----
export function analyzePair(base: string, arr: (number | null)[], volume: number | null, basis: number | null, maxMove: number | null) {
  const have = nn(arr).length;
  if (nn(arr.slice(-180)).length < MIN_RECENT)
    return { base, eligible: false, reasons: ["Less than about 180 days of overlapping history"], flags: [] as string[], days: have };

  const fee = roundTripFee();
  const sign = sum(nn(arr.slice(-90))) >= 0 ? 1 : -1;
  const s = arr.map((x) => (x === null ? null : x * sign));
  const s180 = nn(s.slice(-180)), s90 = nn(s.slice(-90)), s30 = nn(s.slice(-30));
  const mean30 = mean(s30), mean90 = mean(s90), med90 = median(s90);
  const expected = Math.min(mean30, mean90, med90) * SHRINK; // daily, per unit notional

  const top = [...s180].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(s180.length * 0.05)));
  const total = sum(s180);
  const spike = total > 0 ? Math.min(1, sum(top) / total) : 1;

  const ac1 = autocorr(s180, 1);
  const halfLife = ac1 != null && ac1 > 0 && ac1 < 1 ? -Math.LN2 / Math.log(ac1) : null;
  let cum = 0, peak = 0, dd = 0;
  for (const x of s180) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const raw = nn(arr.slice(-180)); let flips = 0;
  for (let i = 1; i < raw.length; i++) if (raw[i] !== 0 && raw[i - 1] !== 0 && Math.sign(raw[i]) !== Math.sign(raw[i - 1])) flips++;

  // Block bootstrap: resample 7-day chunks of the last 180 days into 120-day paths
  const cost = fee + 4 * slipPerLeg(volume);
  const rand = rng(hash(base)), sims: number[] = [];
  for (let k = 0; k < SIMS; k++) {
    let tot = 0, len = 0;
    while (len < HORIZON) {
      const st = Math.floor(rand() * (s180.length - BLOCK + 1));
      for (let j = 0; j < BLOCK && len < HORIZON; j++, len++) tot += s180[st + j];
    }
    sims.push(tot - cost);
  }
  sims.sort((a, b) => a - b);
  const pc = (p: number) => sims[Math.floor(p * (SIMS - 1))];
  const p10 = pc(0.1), p50 = pc(0.5), p90 = pc(0.9), pWin = sims.filter((x) => x > 0).length / SIMS;

  const lev = maxMove == null ? 1 : Math.max(1, Math.min(5, Math.floor(1 / (maxMove * 1.2 + 0.005))));
  const retCap = p50 * (365 / HORIZON) * (lev / 2); // capital = 2 x notional / leverage

  const reasons: string[] = [], flags: string[] = [];
  if (volume == null) reasons.push("No live market data");
  else if (volume < minVolume()) reasons.push("Trading volume too low");
  if (spike > 0.6) reasons.push("Profit comes from a few spike days");
  if (expected <= 0) reasons.push("No positive expected spread");
  if (basis != null && Math.abs(basis) > 0.005) flags.push("Wide price gap between exchanges");
  if (flips > 30) flags.push("Spread flips sign often");
  if (volume != null && volume < 1e7) flags.push("Thin liquidity");
  if (spike > 0.4) flags.push("Spike-heavy");
  if (maxMove == null) flags.push("No price history for margin check");

  return {
    base, eligible: reasons.length === 0, reasons, flags, days: have,
    direction: sign === 1 ? DIR_A : DIR_B,
    mean30, mean90, med90, expected, spike, half_life: halfLife, max_dd: dd, flips,
    p10, p50, p90, p_win: pWin, cost, volume, basis, max_move: maxMove, lev, ret_cap: retCap,
    series: s.slice(-180).map((x) => (x === null ? null : rounded(x))),
  };
}

/** Walk-forward observations: at each past date, judge a pair using only data before it, then record what it earned next. */
export function walkForward(arr: (number | null)[]) {
  const fee = roundTripFee(), obs: any[] = [];
  for (let t = LOOKBACK; t <= N - HORIZON; t += 10) {
    const lb = arr.slice(t - LOOKBACK, t), fw = nn(arr.slice(t, t + HORIZON));
    const lbv = nn(lb);
    if (lbv.length < 70 || fw.length < 100) continue;
    const sign = sum(lbv) >= 0 ? 1 : -1;
    const l90 = lbv.map((x) => x * sign), l30 = nn(lb.slice(-30)).map((x) => x * sign);
    if (l30.length < 20) continue;
    const m30 = mean(l30), m90 = mean(l90), md90 = median(l90);
    obs.push({ fold: t, m30, m90, md90, cons: Math.min(m30, m90, md90), fwd: (sum(fw.map((x) => x * sign)) * HORIZON) / fw.length - fee });
  }
  return obs;
}

// ---- Admin steps ----
export async function recInit() {
  await q(`DELETE FROM wf_obs`);
  const rows = await q(`SELECT base FROM pair_map WHERE active ORDER BY base`);
  return { bases: rows.map((r: any) => r.base as string) };
}

export async function recChunk(bases: string[]) {
  const [daily, meta] = await Promise.all([
    loadDaily(bases),
    q(`SELECT p.base,p.binance_symbol,p.b_mult,p.d_mult,l.b_vol,l.d_vol,l.b_mark,l.d_mark
         FROM pair_map p LEFT JOIN live_snapshot l ON l.base=p.base WHERE p.base = ANY($1::text[])`, [bases]),
  ]);
  const moves = await Promise.allSettled(meta.map((m: any) => binanceWorstMove(m.binance_symbol)));
  const feats: any[] = [], obs: any[] = [];
  meta.forEach((m: any, i: number) => {
    const arr = daily.get(m.base);
    if (!arr) return;
    const vol = m.b_vol != null && m.d_vol != null ? Math.min(m.b_vol, m.d_vol) : null;
    const basis = m.b_mark && m.d_mark ? m.d_mark / m.d_mult / (m.b_mark / m.b_mult) - 1 : null;
    const mv = moves[i].status === "fulfilled" ? (moves[i] as any).value : null;
    feats.push({ base: m.base, data: analyzePair(m.base, arr, vol, basis, mv) });
    for (const o of walkForward(arr)) obs.push({ base: m.base, ...o });
  });
  if (feats.length)
    await q(`INSERT INTO pair_features(base,data,updated_at) SELECT base,data,now() FROM jsonb_to_recordset($1::jsonb) AS x(base text,data jsonb)
             ON CONFLICT (base) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [JSON.stringify(feats)]);
  if (obs.length)
    await q(`INSERT INTO wf_obs(base,fold,m30,m90,md90,cons,fwd)
             SELECT base,fold,m30,m90,md90,cons,fwd FROM jsonb_to_recordset($1::jsonb)
             AS x(base text,fold int,m30 float8,m90 float8,md90 float8,cons float8,fwd float8)
             ON CONFLICT (base,fold) DO UPDATE SET m30=EXCLUDED.m30,m90=EXCLUDED.m90,md90=EXCLUDED.md90,cons=EXCLUDED.cons,fwd=EXCLUDED.fwd`,
            [JSON.stringify(obs)]);
  return { analyzed: feats.length, observations: obs.length };
}

/** Does each ranking rule actually predict what pairs earned over the following 120 days? */
export async function recFinish() {
  const rows = await q(`SELECT base,fold,m30,m90,md90,cons,fwd FROM wf_obs`);
  const byFold = new Map<number, any[]>();
  for (const r of rows) { const a = byFold.get(r.fold) ?? []; a.push(r); byFold.set(r.fold, a); }
  const groups = [...byFold.values()].filter((g) => g.length >= 15);
  const names = ["m30", "m90", "md90", "cons"];
  const predictors: any = {};
  for (const name of names) {
    const ics: number[] = [], tops: number[] = [], hits: number[] = [];
    for (const g of groups) {
      const x = g.map((r) => r[name]), y = g.map((r) => r.fwd);
      const ic = pearson(ranks(x), ranks(y)); if (ic != null) ics.push(ic);
      const sorted = [...g].sort((a, b) => b[name] - a[name]).slice(0, Math.ceil(g.length / 4));
      tops.push(mean(sorted.map((r) => r.fwd))); hits.push(sorted.filter((r) => r.fwd > 0).length / sorted.length);
    }
    predictors[name] = { ic: mean(ics), ic_pos: ics.length ? ics.filter((v) => v > 0).length / ics.length : null, top_avg: mean(tops), hit: mean(hits) };
  }
  const summary = {
    folds: groups.length, pairs: new Set(rows.map((r: any) => r.base)).size, lookback: LOOKBACK, horizon: HORIZON,
    all_avg: mean(groups.map((g) => mean(g.map((r) => r.fwd)))), predictors, as_of: new Date().toISOString(),
  };
  await q(`INSERT INTO wf_summary(id,data,updated_at) VALUES (1,$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [JSON.stringify(summary)]);
  return summary;
}

// ---- Read side ----
function corr(a: (number | null)[], b: (number | null)[]) {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null) { x.push(a[i]!); y.push(b[i]!); }
  return x.length >= 60 ? pearson(x, y) : null;
}

export async function getRecommendations() {
  const [rows, [sum_]] = await Promise.all([
    q(`SELECT data, updated_at FROM pair_features`),
    q(`SELECT data FROM wf_summary WHERE id=1`),
  ]);
  const all = rows.map((r: any) => ({ ...r.data, updated_at: r.updated_at }));
  const eligible = all.filter((x: any) => x.eligible).sort((a: any, b: any) => b.p10 - a.p10);

  // Diversified basket: best pessimistic return first, skip pairs whose daily spread moves with one already picked
  const basket: any[] = [];
  for (const c of eligible) {
    if (basket.length >= 8 || c.p10 <= 0) continue;
    if (basket.every((b) => { const k = corr(c.series, b.series); return k == null || k < 0.6; })) basket.push(c);
  }
  const strip = ({ series, ...rest }: any) => rest;
  return {
    basket: basket.map((b) => b.base),
    eligible: eligible.map(strip),
    excluded: all.filter((x: any) => !x.eligible).map(strip),
    validation: sum_?.data ?? null,
    as_of: rows.length ? rows.reduce((m: any, r: any) => (r.updated_at > m ? r.updated_at : m), rows[0].updated_at) : null,
    settings: { horizon: HORIZON, lookback: LOOKBACK, shrink: SHRINK, min_volume: minVolume() },
  };
}