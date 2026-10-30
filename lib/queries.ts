import { q } from "./db";
import { perDay } from "./calc";

export async function getPairs() {
  const rows = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol,p.b_mult,p.d_mult,p.coindcx_pair,p.c_interval,p.bybit_symbol,p.y_mult,p.y_interval AS mapped_y_interval,
            s.direction,s.days,s.days90,s.ret7,s.ret30,s.net30,s.ret90,s.net90,s.apr,s.trend3_apr,s.consistency,s.spread_std,s.sign_flips,s.breakeven_days,
            l.c_rate,l.c_mark,l.b_rate,l.d_rate,l.b_interval,l.d_interval,l.b_mark,l.d_mark,l.b_vol,l.d_vol,l.d_oi,l.y_rate,l.y_interval,l.y_mark,l.y_vol,l.y_oi,l.ts AS live_ts,
            y.direction AS y_direction,y.days AS y_days,y.days90 AS y_days90,y.ret7 AS y_ret7,y.ret30 AS y_ret30,y.net30 AS y_net30,y.ret90 AS y_ret90,y.net90 AS y_net90,y.apr AS y_apr,y.trend3_apr AS y_trend3_apr,y.consistency AS y_consistency,y.spread_std AS y_spread_std,y.sign_flips AS y_sign_flips,y.breakeven_days AS y_breakeven_days,
            ss.last_synced_at
       FROM pair_map p LEFT JOIN pair_stats s ON s.base=p.base LEFT JOIN bybit_pair_stats y ON y.base=p.base LEFT JOIN live_snapshot l ON l.base=p.base
       LEFT JOIN sync_state ss ON ss.base=p.base WHERE p.active`,
  );
  return rows.map((r: any) => {
    const bd = perDay(r.b_rate, r.b_interval), dd = perDay(r.d_rate, r.d_interval);
    const cd = perDay(r.c_rate, r.c_interval ?? 8);
    const yd = perDay(r.y_rate, r.y_interval ?? r.mapped_y_interval ?? 8);
    const live = bd != null && dd != null ? bd - dd : null;
    const basis = r.b_mark && r.d_mark ? (r.d_mark / r.d_mult) / (r.b_mark / r.b_mult) - 1 : null;
    return {
      ...r,
      c_apr: cd == null ? null : cd * 365,
      d_apr: dd == null ? null : dd * 365,
      dcx_apr: cd != null && dd != null ? Math.abs(cd - dd) * 365 : null,
      dcx_direction: cd != null && dd != null ? (cd >= dd ? "SHORT_COINDCX_LONG_DELTA" : "LONG_COINDCX_SHORT_DELTA") : null,
      dcx_basis: r.c_mark && r.d_mark ? r.d_mark / r.d_mult / (r.c_mark / r.b_mult) - 1 : null,
      live_apr: live == null ? null : Math.abs(live) * 365,
      live_direction: live == null ? null : live >= 0 ? "SHORT_BINANCE_LONG_DELTA" : "LONG_BINANCE_SHORT_DELTA",
      y_live_apr: bd != null && yd != null ? Math.abs(bd - yd) * 365 : null,
      y_live_direction: bd == null || yd == null ? null : bd >= yd ? "SHORT_BINANCE_LONG_BYBIT" : "LONG_BINANCE_SHORT_BYBIT",
      y_basis: r.b_mark && r.y_mark ? (r.y_mark / (r.y_mult ?? 1)) / (r.b_mark / r.b_mult) - 1 : null,
      y_volume: r.b_vol != null && r.y_vol != null ? Math.min(r.b_vol, r.y_vol) : null,
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
