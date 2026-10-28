export const pct = (v: number | null | undefined, d = 1) => (v == null ? "-" : `${(v * 100).toFixed(d)}%`);
export const signedPct = (v: number | null | undefined, d = 2) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
export const usd = (v: number | null | undefined) => {
  if (v == null) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
export const cls = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "gain" : "loss");
export const dirLabel = (d: string | null | undefined) =>
  d === "SHORT_BINANCE_LONG_DELTA" ? "Short Binance / Long Delta"
  : d === "LONG_BINANCE_SHORT_DELTA" ? "Long Binance / Short Delta"
  : d === "SHORT_COINDCX_LONG_DELTA" ? "Short CoinDCX / Long Delta"
  : d === "LONG_COINDCX_SHORT_DELTA" ? "Long CoinDCX / Short Delta" : "-";
export function freshness(ts: string | null | undefined) {
  if (!ts) return { c: "r", t: "never synced" };
  const mins = (Date.now() - new Date(ts).getTime()) / 60000;
  const t = mins < 60 ? `${Math.round(mins)}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return { c: mins < 30 ? "g" : mins < 180 ? "y" : "r", t };
}