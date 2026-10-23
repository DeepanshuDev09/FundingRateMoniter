import { q } from "./db";
import { perDay } from "./calc";

export async function getPairs() {
  const rows = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol,p.b_mult,p.d_mult,
            s.direction,s.days,s.days90,s.ret7,s.ret30,s.net30,s.ret90,s.net90,s.apr,s.trend3_apr,s.consistency,s.spread_std,s.sign_flips,s.breakeven_days,
            l.b_rate,l.d_rate,l.b_interval,l.d_interval,l.b_mark,l.d_mark,l.b_vol,l.d_vol,l.d_oi,l.ts AS live_ts,
            ss.last_synced_at
       FROM pair_map p LEFT JOIN pair_stats s ON s.base=p.base LEFT JOIN live_snapshot l ON l.base=p.base
       LEFT JOIN sync_state ss ON ss.base=p.base WHERE p.active`,
  );
  return rows.map((r: any) => {
    const bd = perDay(r.b_rate, r.b_interval), dd = perDay(r.d_rate, r.d_interval);
    const live = bd != null && dd != null ? bd - dd : null;
    const basis = r.b_mark && r.d_mark ? (r.d_mark / r.d_mult) / (r.b_mark / r.b_mult) - 1 : null;
    return {
      ...r,
      live_apr: live == null ? null : Math.abs(live) * 365,
      live_direction: live == null ? null : live >= 0 ? "SHORT_BINANCE_LONG_DELTA" : "LONG_BINANCE_SHORT_DELTA",
      basis,
      volume: r.b_vol != null && r.d_vol != null ? Math.min(r.b_vol, r.d_vol) : null,
    };
  });
}

export async function getPairDetail(base: string) {
  const [pair] = (await getPairs()).filter((p: any) => p.base === base);
  if (!pair) return null;
  const rows = await q(
    `SELECT exchange, EXTRACT(EPOCH FROM ts)*1000 AS ts, rate FROM funding_history
      WHERE base=$1 AND ts > now() - interval '91 days' ORDER BY ts`, [base]);
  const mk = (ex: string) => rows.filter((r: any) => r.exchange === ex).map((r: any) => ({ ts: Number(r.ts), rate: Number(r.rate) }));
  return { pair, binance: mk("binance"), delta: mk("delta") };
}