import { q } from "./db";
import { analyze, BYBIT_DIR_A, BYBIT_DIR_B } from "./calc";
import { binanceHistory, binanceLive, binanceSymbols, bybitHistory, bybitLive, bybitSymbols, coindcxFundingHours, coindcxPrices, deltaHistory, deltaProducts, deltaTickers, normBase } from "./exchanges";

const DAY = 86400000;
const feeRoundTrip = () =>
  2 * (Number(process.env.TAKER_FEE_BINANCE ?? 0.0005) + Number(process.env.TAKER_FEE_DELTA ?? 0.0005));

/** Rebuild the common-pair list (stored in Postgres; served as JSON at /api/common-pairs). */
export async function refreshPairs() {
  const warnings: string[] = [];
  const [bs, dp] = await Promise.all([binanceSymbols(), deltaProducts()]);
  const bm = new Map<string, { symbol: string; mult: number }>();
  for (const s of bs) { const n = normBase(s.base); bm.set(n.base, { symbol: s.symbol, mult: n.mult }); }

  const chosen = new Map<string, any>();
  for (const p of dp) {
    const n = normBase(p.base);
    const b = bm.get(n.base);
    if (!b) continue;
    const row = { base: n.base, binance_symbol: b.symbol, delta_symbol: p.symbol, b_mult: b.mult, d_mult: n.mult };
    // If Delta lists both a USD and a USDT contract, prefer USD.
    if (!chosen.has(n.base) || p.quote === "USD") chosen.set(n.base, row);
  }
  const rows = [...chosen.values()];

  // Bybit USDT linear perps are matched by normalized base, just like the other exchanges.
  // If Bybit is unreachable (e.g. region block) keep the mapping we already stored instead of wiping it or failing the whole sync.
  const ym = new Map<string, { symbol: string; mult: number; interval: number }>();
  try {
    for (const y of await bybitSymbols()) { const n = normBase(y.base); ym.set(n.base, { symbol: y.symbol, mult: n.mult, interval: y.interval }); }
  } catch (e: any) {
    warnings.push(`Bybit symbol list failed, reusing saved mapping: ${String(e.message).slice(0, 160)}`);
    const old = await q(`SELECT base,bybit_symbol,y_mult,y_interval FROM pair_map WHERE bybit_symbol IS NOT NULL`).catch(() => []);
    for (const o of old) ym.set(o.base, { symbol: o.bybit_symbol, mult: o.y_mult ?? 1, interval: o.y_interval ?? 8 });
  }
  for (const r of rows) {
    const y = ym.get(r.base);
    r.bybit_symbol = y?.symbol ?? null; r.y_mult = y?.mult ?? null; r.y_interval = y?.interval ?? null;
  }
  for (const [base, y] of ym) {
    if (chosen.has(base)) continue;
    const b = bm.get(base);
    if (b) rows.push({ base, binance_symbol: b.symbol, delta_symbol: null, b_mult: b.mult, d_mult: 1, bybit_symbol: y.symbol, y_mult: y.mult, y_interval: y.interval });
  }

  // CoinDCX: match its USDT futures to the same base asset. If CoinDCX is unreachable, carry on without it.
  try {
    const dcx = await coindcxPrices();
    const byBase = new Map<string, string>();
    for (const pair of dcx.keys()) {
      const m = /^B-(.+)_USDT$/.exec(pair);
      if (m) byBase.set(normBase(m[1]).base, pair);
    }
    for (const r of rows) r.coindcx_pair = byBase.get(r.base) ?? null;
    const withDcx = rows.filter((r) => r.coindcx_pair);
    for (let i = 0; i < withDcx.length; i += 10) // gentle: 10 lookups at a time
      await Promise.all(withDcx.slice(i, i + 10).map(async (r) => { r.c_interval = await coindcxFundingHours(r.coindcx_pair); }));
  } catch { /* leave CoinDCX columns empty */ }

  await q(
    `INSERT INTO pair_map(base,binance_symbol,delta_symbol,b_mult,d_mult,coindcx_pair,c_interval,bybit_symbol,y_mult,y_interval,active)
     SELECT base,binance_symbol,delta_symbol,b_mult,d_mult,coindcx_pair,c_interval,bybit_symbol,y_mult,y_interval,true
     FROM jsonb_to_recordset($1::jsonb) AS x(base text,binance_symbol text,delta_symbol text,b_mult real,d_mult real,coindcx_pair text,c_interval real,bybit_symbol text,y_mult real,y_interval real)
     ON CONFLICT (base) DO UPDATE SET binance_symbol=EXCLUDED.binance_symbol, delta_symbol=EXCLUDED.delta_symbol,
       b_mult=EXCLUDED.b_mult, d_mult=EXCLUDED.d_mult, coindcx_pair=EXCLUDED.coindcx_pair, c_interval=EXCLUDED.c_interval,
       bybit_symbol=EXCLUDED.bybit_symbol, y_mult=EXCLUDED.y_mult, y_interval=EXCLUDED.y_interval, active=true`,
    [JSON.stringify(rows)],
  );
  await q(`UPDATE pair_map SET active=false WHERE NOT (base = ANY($1::text[]))`, [rows.map((r) => r.base)]);
  await q(`INSERT INTO sync_state(base) SELECT base FROM pair_map ON CONFLICT DO NOTHING`);
  return { count: rows.length, warnings };
}

/** One bulk call per exchange -> live rate, mark price, volume for every common pair. */
export async function refreshLive() {
  const pairs = await q(`SELECT base,binance_symbol,delta_symbol,coindcx_pair,bybit_symbol FROM pair_map WHERE active`);
  const warnings: string[] = [];
  const [bl, dl, yl, cl] = await Promise.all([
    binanceLive(), deltaTickers(),
    bybitLive().catch((e) => { warnings.push(`Bybit live rates failed: ${String(e.message).slice(0, 160)}`); return null; }),
    coindcxPrices().catch(() => new Map()),
  ]);
  // If Bybit failed, keep the last saved Bybit numbers rather than blanking the tab.
  const oldY = new Map<string, any>();
  if (!yl) for (const o of await q(`SELECT base,y_rate,y_interval,y_mark,y_vol,y_oi FROM live_snapshot WHERE y_rate IS NOT NULL`)) oldY.set(o.base, o);
  const dInterval = Number(process.env.DELTA_FUNDING_INTERVAL_HOURS ?? 8);
  const rows: any[] = [];
  for (const p of pairs) {
    const b = bl.get(p.binance_symbol), d = p.delta_symbol ? dl.get(p.delta_symbol) : null;
    if (!b) continue;
    const c = p.coindcx_pair ? cl.get(p.coindcx_pair) : null;
    const y = p.bybit_symbol ? (yl ? yl.get(p.bybit_symbol) : oldY.get(p.base) && { rate: oldY.get(p.base).y_rate, interval: oldY.get(p.base).y_interval, mark: oldY.get(p.base).y_mark, vol: oldY.get(p.base).y_vol, oi: oldY.get(p.base).y_oi }) : null;
    rows.push({
      base: p.base, b_rate: b.rate, d_rate: d?.rate ?? null, b_interval: b.interval, d_interval: d ? dInterval : null,
      b_mark: b.mark, d_mark: d?.mark ?? null, b_vol: b.vol, d_vol: d?.vol ?? null, d_oi: d?.oi ?? null,
      c_rate: c ? c.rate : null, c_mark: c ? c.mark : null,
      y_rate: y ? y.rate : null, y_interval: y ? y.interval : null, y_mark: y ? y.mark : null, y_vol: y ? y.vol : null, y_oi: y ? y.oi : null,
    });
  }
  await q(
    `INSERT INTO live_snapshot(base,b_rate,d_rate,b_interval,d_interval,b_mark,d_mark,b_vol,d_vol,d_oi,c_rate,c_mark,y_rate,y_interval,y_mark,y_vol,y_oi,ts)
     SELECT base,b_rate,d_rate,b_interval,d_interval,b_mark,d_mark,b_vol,d_vol,d_oi,c_rate,c_mark,y_rate,y_interval,y_mark,y_vol,y_oi,now()
     FROM jsonb_to_recordset($1::jsonb) AS x(base text,b_rate float8,d_rate float8,b_interval real,d_interval real,
       b_mark float8,d_mark float8,b_vol float8,d_vol float8,d_oi float8,c_rate float8,c_mark float8,y_rate float8,y_interval real,y_mark float8,y_vol float8,y_oi float8)
     ON CONFLICT (base) DO UPDATE SET b_rate=EXCLUDED.b_rate,d_rate=EXCLUDED.d_rate,b_interval=EXCLUDED.b_interval,
       d_interval=EXCLUDED.d_interval,b_mark=EXCLUDED.b_mark,d_mark=EXCLUDED.d_mark,b_vol=EXCLUDED.b_vol,
       d_vol=EXCLUDED.d_vol,d_oi=EXCLUDED.d_oi,c_rate=EXCLUDED.c_rate,c_mark=EXCLUDED.c_mark,y_rate=EXCLUDED.y_rate,y_interval=EXCLUDED.y_interval,y_mark=EXCLUDED.y_mark,y_vol=EXCLUDED.y_vol,y_oi=EXCLUDED.y_oi,ts=now()`,
    [JSON.stringify(rows)],
  );
  return { count: rows.length, warnings };
}

async function syncOne(p: any) {
  const last = await q(
    `SELECT exchange, EXTRACT(EPOCH FROM MIN(ts))*1000 AS min_ms, EXTRACT(EPOCH FROM MAX(ts))*1000 AS max_ms
       FROM funding_history WHERE base=$1 GROUP BY exchange`, [p.base]);
  const lm = Object.fromEntries(last.map((r: any) => [r.exchange, { min: Number(r.min_ms), max: Number(r.max_ms) }]));
  const from = Date.now() - 365 * DAY;
  // Backfill a full year once per pair (tracked in sync_state.backfill_days); after that only fetch what's new.
  const [st] = await q(`SELECT backfill_days FROM sync_state WHERE base=$1`, [p.base]);
  const full = (st?.backfill_days ?? 0) >= 365;
  const startFor = (ex: string) => (full && lm[ex] ? lm[ex].max + 1 : from);
  const [bi] = await q(`SELECT b_interval,y_interval FROM live_snapshot WHERE base=$1`, [p.base]);

  let bybitError = "";
  const [b, d, y] = await Promise.all([
    binanceHistory(p.binance_symbol, startFor("binance"), bi?.b_interval ?? 8),
    p.delta_symbol ? deltaHistory(p.delta_symbol, startFor("delta")) : Promise.resolve([]),
    p.bybit_symbol
      ? bybitHistory(p.bybit_symbol, startFor("bybit"), bi?.y_interval ?? p.y_interval ?? 8)
          .catch((e) => { bybitError = String(e.message).slice(0, 140); return [] as Awaited<ReturnType<typeof bybitHistory>>; })
      : Promise.resolve([]),
  ]);
  const rows = [
    ...b.map((r) => ({ base: p.base, exchange: "binance", ts: new Date(r.ts).toISOString(), rate: r.rate, interval_hours: r.interval })),
    ...d.map((r) => ({ base: p.base, exchange: "delta", ts: new Date(r.ts).toISOString(), rate: r.rate, interval_hours: r.interval })),
    ...y.map((r) => ({ base: p.base, exchange: "bybit", ts: new Date(r.ts).toISOString(), rate: r.rate, interval_hours: r.interval })),
  ];
  if (rows.length) {
    await q(
      `INSERT INTO funding_history(base,exchange,ts,rate,interval_hours)
       SELECT base,exchange,ts,rate,interval_hours FROM jsonb_to_recordset($1::jsonb)
       AS x(base text,exchange text,ts timestamptz,rate float8,interval_hours real) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows)],
    );
  }
  await recomputeStats(p.base);
  // Only mark the year as fully backfilled when Bybit didn't fail, so a failed Bybit download is retried next sync.
  await q(`UPDATE sync_state SET last_synced_at=now(), backfill_days=CASE WHEN $2 THEN backfill_days ELSE 365 END WHERE base=$1`, [p.base, !!bybitError]);
  return { rows: rows.length, bybitError };
}

/** Sync up to N pairs not yet synced since `since` (ISO). Returns results + how many remain. */
export async function syncHistory(n: number, since: string) {
  const where = `p.active AND (s.last_synced_at IS NULL OR s.last_synced_at < $1::timestamptz)`;
  const pick = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol,p.bybit_symbol,p.y_interval FROM pair_map p
       LEFT JOIN sync_state s ON s.base=p.base LEFT JOIN live_snapshot l ON l.base=p.base
      WHERE ${where}
      ORDER BY COALESCE(LEAST(l.b_vol,l.d_vol),0) DESC LIMIT $2`,
    [since, n],
  );
  const res = await Promise.allSettled(pick.map(syncOne));
  // A failed pair is stamped too, so one bad pair can't block the run; it is reported in the log.
  const failed = pick.filter((_: any, i: number) => res[i].status === "rejected").map((p: any) => p.base);
  if (failed.length) await q(`UPDATE sync_state SET last_synced_at=now() WHERE base = ANY($1::text[])`, [failed]);
  const [{ c }] = await q(
    `SELECT COUNT(*)::int AS c FROM pair_map p LEFT JOIN sync_state s ON s.base=p.base WHERE ${where}`, [since]);
  return {
    results: pick.map((p: any, i: number) => ({
      base: p.base, ok: res[i].status === "fulfilled",
      error: res[i].status === "rejected" ? String((res[i] as any).reason).slice(0, 140) : undefined,
      warn: res[i].status === "fulfilled" && (res[i] as any).value.bybitError ? `Bybit: ${(res[i] as any).value.bybitError}` : undefined,
    })),
    remaining: c as number,
  };
}

export async function recomputeStats(base: string) {
  const rows = await q(
    `SELECT exchange, EXTRACT(EPOCH FROM ts)*1000 AS ts, rate FROM funding_history
      WHERE base=$1 AND ts > now() - interval '91 days' ORDER BY ts`,
    [base],
  );
  const mk = (ex: string) => rows.filter((r: any) => r.exchange === ex).map((r: any) => ({ ts: Number(r.ts), rate: Number(r.rate) }));
  const s = analyze(mk("binance"), mk("delta"), feeRoundTrip());
  // Don't return early when there is no Delta data: Bybit-only pairs still need their Bybit stats below.
  if (s) await q(
    `INSERT INTO pair_stats(base,direction,days,ret7,ret30,net30,avg_daily,apr,trend3_apr,consistency,spread_std,sign_flips,breakeven_days,ret90,net90,days90,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (base) DO UPDATE SET direction=$2,days=$3,ret7=$4,ret30=$5,net30=$6,avg_daily=$7,apr=$8,
       trend3_apr=$9,consistency=$10,spread_std=$11,sign_flips=$12,breakeven_days=$13,ret90=$14,net90=$15,days90=$16,updated_at=now()`,
    [base, s.direction, s.days, s.ret7, s.ret30, s.net30, s.avg_daily, s.apr, s.trend3_apr, s.consistency, s.spread_std, s.sign_flips, s.breakeven_days, s.ret90, s.net90, s.days90],
  );
  const y = analyze(mk("binance"), mk("bybit"), 2 * (Number(process.env.TAKER_FEE_BINANCE ?? 0.0005) + Number(process.env.TAKER_FEE_BYBIT ?? 0.00055)), [BYBIT_DIR_A, BYBIT_DIR_B]);
  if (y) await q(
    `INSERT INTO bybit_pair_stats(base,direction,days,ret7,ret30,net30,avg_daily,apr,trend3_apr,consistency,spread_std,sign_flips,breakeven_days,ret90,net90,days90,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (base) DO UPDATE SET direction=$2,days=$3,ret7=$4,ret30=$5,net30=$6,avg_daily=$7,apr=$8,trend3_apr=$9,consistency=$10,spread_std=$11,sign_flips=$12,breakeven_days=$13,ret90=$14,net90=$15,days90=$16,updated_at=now()`,
    [base, y.direction, y.days, y.ret7, y.ret30, y.net30, y.avg_daily, y.apr, y.trend3_apr, y.consistency, y.spread_std, y.sign_flips, y.breakeven_days, y.ret90, y.net90, y.days90],
  );
}
