import { q } from "./db";
import { perDay } from "./calc";

export async function getPairs() {
  const rows = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol,p.b_mult,p.d_mult,p.coindcx_pair,p.c_interval,p.bybit_symbol,p.y_mult,p.y_interval AS mapped_y_interval,
            s.dyn_direction,s.dyn_flips,s.dyn_flips30,s.dyn_ret30,s.dyn_net30,s.dyn_ret90,s.dyn_net90,s.dyn_ret365,s.dyn_net365,
            s.direction,s.days,s.days90,s.days365,s.ret1,s.ret7,s.ret30,s.net30,s.ret90,s.net90,s.ret365,s.net365,s.apr,s.trend3_apr,s.consistency,s.spread_std,s.sign_flips,s.breakeven_days,
            l.c_rate,l.c_mark,l.b_rate,l.d_rate,l.b_interval,l.d_interval,l.b_mark,l.d_mark,l.b_vol,l.d_vol,l.d_oi,l.y_rate,l.y_interval,l.y_mark,l.y_vol,l.y_oi,l.ts AS live_ts,
            y.dyn_direction AS y_dyn_direction,y.dyn_flips AS y_dyn_flips,y.dyn_flips30 AS y_dyn_flips30,y.dyn_ret30 AS y_dyn_ret30,y.dyn_net30 AS y_dyn_net30,y.dyn_ret90 AS y_dyn_ret90,y.dyn_net90 AS y_dyn_net90,y.dyn_ret365 AS y_dyn_ret365,y.dyn_net365 AS y_dyn_net365,
            y.direction AS y_direction,y.days AS y_days,y.days90 AS y_days90,y.days365 AS y_days365,y.ret1 AS y_ret1,y.ret7 AS y_ret7,y.ret30 AS y_ret30,y.net30 AS y_net30,y.ret90 AS y_ret90,y.net90 AS y_net90,y.ret365 AS y_ret365,y.net365 AS y_net365,y.apr AS y_apr,y.trend3_apr AS y_trend3_apr,y.consistency AS y_consistency,y.spread_std AS y_spread_std,y.sign_flips AS y_sign_flips,y.breakeven_days AS y_breakeven_days,
            yd.dyn_direction AS yd_dyn_direction,yd.dyn_flips AS yd_dyn_flips,yd.dyn_flips30 AS yd_dyn_flips30,yd.dyn_ret30 AS yd_dyn_ret30,yd.dyn_net30 AS yd_dyn_net30,yd.dyn_ret90 AS yd_dyn_ret90,yd.dyn_net90 AS yd_dyn_net90,yd.dyn_ret365 AS yd_dyn_ret365,yd.dyn_net365 AS yd_dyn_net365,
            yd.direction AS yd_direction,yd.days AS yd_days,yd.days90 AS yd_days90,yd.days365 AS yd_days365,yd.ret1 AS yd_ret1,yd.ret7 AS yd_ret7,yd.ret30 AS yd_ret30,yd.net30 AS yd_net30,yd.ret90 AS yd_ret90,yd.net90 AS yd_net90,yd.ret365 AS yd_ret365,yd.net365 AS yd_net365,yd.apr AS yd_apr,yd.trend3_apr AS yd_trend3_apr,yd.consistency AS yd_consistency,yd.spread_std AS yd_spread_std,yd.sign_flips AS yd_sign_flips,yd.breakeven_days AS yd_breakeven_days,
            ss.last_synced_at,ss.bybit_delta_last_synced_at
       FROM pair_map p LEFT JOIN pair_stats s ON s.base=p.base LEFT JOIN bybit_pair_stats y ON y.base=p.base
       LEFT JOIN bybit_delta_pair_stats yd ON yd.base=p.base LEFT JOIN live_snapshot l ON l.base=p.base
       LEFT JOIN sync_state ss ON ss.base=p.base WHERE p.active`,
  );
  return rows.map((r: any) => {
    const bd = perDay(r.b_rate, r.b_interval), dd = perDay(r.d_rate, r.d_interval);
    const cd = perDay(r.c_rate, r.c_interval ?? 8);
    const yd = perDay(r.y_rate, r.y_interval ?? r.mapped_y_interval ?? 8);
    const yDeltaLive = yd != null && dd != null ? yd - dd : null;
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
      yd_live_apr: yDeltaLive == null ? null : Math.abs(yDeltaLive) * 365,
      yd_live_direction: yDeltaLive == null ? null : yDeltaLive >= 0 ? "SHORT_BYBIT_LONG_DELTA" : "LONG_BYBIT_SHORT_DELTA",
      yd_basis: r.y_mark && r.d_mark ? (r.d_mark / r.d_mult) / (r.y_mark / (r.y_mult ?? 1)) - 1 : null,
      yd_volume: r.y_vol != null && r.d_vol != null ? Math.min(r.y_vol, r.d_vol) : null,
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
      WHERE base=$1 AND ts > now() - interval '366 days' ORDER BY ts`, [base]);
  const mk = (ex: string) => rows.filter((r: any) => r.exchange === ex).map((r: any) => ({ ts: Number(r.ts), rate: Number(r.rate) }));
  return { pair, binance: mk("binance"), delta: mk("delta"), bybit: mk("bybit") };
}