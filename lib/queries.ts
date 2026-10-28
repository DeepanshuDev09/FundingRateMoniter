import { q } from "./db";
import { perDay } from "./calc";

export async function getPairs() {
  const rows = await q(
    `SELECT p.base,p.binance_symbol,p.delta_symbol,p.b_mult,p.d_mult,p.coindcx_pair,p.c_interval,
            s.direction,s.days,s.days90,s.ret7,s.ret30,s.net30,s.ret90,s.net90,s.apr,s.trend3_apr,s.consistency,s.spread_std,s.sign_flips,s.breakeven_days,
            l.c_rate,l.c_mark,l.b_rate,l.d_rate,l.b_interval,l.d_interval,l.b_mark,l.d_mark,l.b_vol,l.d_vol,l.d_oi,l.ts AS live_ts,
            ss.last_synced_at
       FROM pair_map p LEFT JOIN pair_stats s ON s.base=p.base LEFT JOIN live_snapshot l ON l.base=p.base
       LEFT JOIN sync_state ss ON ss.base=p.base WHERE p.active`,
  );
  return rows.map((r: any) => {
    const bd = perDay(r.b_rate, r.b_interval), dd = perDay(r.d_rate, r.d_interval);
    const cd = perDay(r.c_rate, r.c_interval ?? 8);
    const live = bd != null && dd != null ? bd - dd : null;
    // Best live hedge across all three: short the exchange paying the most, long the one paying the least
    const opts = [["Binance", bd], ["Delta", dd], ["CoinDCX", cd]].filter((o): o is [string, number] => o[1] != null);
    const hi = opts.length >= 2 ? opts.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
    const lo = opts.length >= 2 ? opts.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
    const basis = r.b_mark && r.d_mark ? (r.d_mark / r.d_mult) / (r.b_mark / r.b_mult) - 1 : null;
    return {
      ...r,
      c_apr: cd == null ? null : cd * 365,
      best_apr: hi && lo ? (hi[1] - lo[1]) * 365 : null,
      best_short: hi ? hi[0] : null,
      best_long: lo ? lo[0] : null,
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