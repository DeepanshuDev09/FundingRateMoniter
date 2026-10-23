import { q } from "./db";
import { analyze } from "./calc";
import { binanceHistory, binanceLive, binanceSymbols, deltaHistory, deltaProducts, deltaTickers, normBase } from "./exchanges";

const DAY = 86400000;
const feeRoundTrip = () =>
  2 * (Number(process.env.TAKER_FEE_BINANCE ?? 0.0005) + Number(process.env.TAKER_FEE_DELTA ?? 0.0005));

/** Rebuild the common-pair list (stored in Postgres; served as JSON at /api/common-pairs). */
export async function refreshPairs() {
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
  await q(
    `INSERT INTO pair_map(base,binance_symbol,delta_symbol,b_mult,d_mult,active)
     SELECT base,binance_symbol,delta_symbol,b_mult,d_mult,true
     FROM jsonb_to_recordset($1::jsonb) AS x(base text,binance_symbol text,delta_symbol text,b_mult real,d_mult real)
     ON CONFLICT (base) DO UPDATE SET binance_symbol=EXCLUDED.binance_symbol, delta_symbol=EXCLUDED.delta_symbol,
       b_mult=EXCLUDED.b_mult, d_mult=EXCLUDED.d_mult, active=true`,
    [JSON.stringify(rows)],
  );
  await q(`UPDATE pair_map SET active=false WHERE NOT (base = ANY($1::text[]))`, [rows.map((r) => r.base)]);
  await q(`INSERT INTO sync_state(base) SELECT base FROM pair_map ON CONFLICT DO NOTHING`);
  return rows.length;
}

/** One bulk call per exchange -> live rate, mark price, volume for every common pair. */
export async function refreshLive() {
  const pairs = await q(`SELECT base,binance_symbol,delta_symbol FROM pair_map WHERE active`);
  const [bl, dl] = await Promise.all([binanceLive(), deltaTickers()]);
  const dInterval = Number(process.env.DELTA_FUNDING_INTERVAL_HOURS ?? 8);
  const rows: any[] = [];
  for (const p of pairs) {
    const b = bl.get(p.binance_symbol), d = dl.get(p.delta_symbol);
    if (!b || !d) continue;
    rows.push({
      base: p.base, b_rate: b.rate, d_rate: d.rate, b_interval: b.interval, d_interval: dInterval,
      b_mark: b.mark, d_mark: d.mark, b_vol: b.vol, d_vol: d.vol, d_oi: d.oi,
    });
  }
  await q(
    `INSERT INTO live_snapshot(base,b_rate,d_rate,b_interval,d_interval,b_mark,d_mark,b_vol,d_vol,d_oi,ts)
     SELECT base,b_rate,d_rate,b_interval,d_interval,b_mark,d_mark,b_vol,d_vol,d_oi,now()
     FROM jsonb_to_recordset($1::jsonb) AS x(base text,b_rate float8,d_rate float8,b_interval real,d_interval real,
       b_mark float8,d_mark float8,b_vol float8,d_vol float8,d_oi float8)
     ON CONFLICT (base) DO UPDATE SET b_rate=EXCLUDED.b_rate,d_rate=EXCLUDED.d_rate,b_interval=EXCLUDED.b_interval,
       d_interval=EXCLUDED.d_interval,b_mark=EXCLUDED.b_mark,d_mark=EXCLUDED.d_mark,b_vol=EXCLUDED.b_vol,
       d_vol=EXCLUDED.d_vol,d_oi=EXCLUDED.d_oi,ts=now()`,
    [JSON.stringify(rows)],
  );
  return rows.length;
}

async function syncOne(p: any) {
  const last = await q(
    `SELECT exchange, EXTRACT(EPOCH FROM MIN(ts))*1000 AS min_ms, EXTRACT(EPOCH FROM MAX(ts))*1000 AS max_ms
       FROM funding_history WHERE base=$1 GROUP BY exchange`, [p.base]);
  const lm = Object.fromEntries(last.map((r: any) => [r.exchange, { min: Number(r.min_ms), max: Number(r.max_ms) }]));
  const from = Date.now() - 90 * DAY;
  // Backfill the full 90 days if we don't have it yet (e.g. older 30-day data); otherwise only fetch what's new.
  const startFor = (ex: string) => (lm[ex] && lm[ex].min <= from + 2 * DAY ? lm[ex].max + 1 : from);
  const [bi] = await q(`SELECT b_interval FROM live_snapshot WHERE base=$1`, [p.base]);

  const [b, d] = await Promise.all([
    binanceHistory(p.binance_symbol, startFor("binance"), bi?.b_interval ?? 8),
    deltaHistory(p.delta_symbol, startFor("delta")),
  ]);
  const rows = [
    ...b.map((r) => ({ base: p.base, exchange: "binance", ts: new Date(r.ts).toISOString(), rate: r.rate, interval_hours: r.interval })),
    ...d.map((r) => ({ base: p.base, exchange: "delta", ts: new Date(r.ts).toISOString(), rate: r.rate, interval_hours: r.interval })),
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
  await q(`UPDATE sync_state SET last_synced_at=now() WHERE base=$1`, [p.base]);
  return rows.length;
}

/** Sync up to N pairs not yet synced since `since` (ISO). Returns results + how many remain. */
export async function syncHistory(n: number, since: string) {
  const where = `p.active AND (s.last_synced_at IS NULL OR s.last_synced_at < $1::timestamptz)`;
  const pick = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol FROM pair_map p
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
  if (!s) return;
  await q(
    `INSERT INTO pair_stats(base,direction,days,ret7,ret30,net30,avg_daily,apr,trend3_apr,consistency,spread_std,sign_flips,breakeven_days,ret90,net90,days90,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (base) DO UPDATE SET direction=$2,days=$3,ret7=$4,ret30=$5,net30=$6,avg_daily=$7,apr=$8,
       trend3_apr=$9,consistency=$10,spread_std=$11,sign_flips=$12,breakeven_days=$13,ret90=$14,net90=$15,days90=$16,updated_at=now()`,
    [base, s.direction, s.days, s.ret7, s.ret30, s.net30, s.avg_daily, s.apr, s.trend3_apr, s.consistency, s.spread_std, s.sign_flips, s.breakeven_days, s.ret90, s.net90, s.days90],
  );
}