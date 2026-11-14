import { getPairDetail } from "@/lib/queries";
import { BYBIT_DIR_A, BYBIT_DIR_B, chartSeries, dailyFunding, DIR_A, dynamicFlip, roundTripFeeFor } from "@/lib/calc";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ base: string }> }) {
  const { base } = await params;
  try {
    const d = await getPairDetail(base.toUpperCase());
    if (!d) return Response.json({ error: "unknown pair" }, { status: 404 });
    // ?market=bybit shows the Binance <-> Bybit view of the same pair.
    const bybit = new URL(req.url).searchParams.get("market") === "bybit";
    const direction = bybit
      ? d.pair.y_direction ?? d.pair.y_live_direction ?? BYBIT_DIR_A
      : d.pair.direction ?? DIR_A;
    const series = bybit
      ? chartSeries(d.binance, d.bybit, direction, ["binance", "bybit"])
      : chartSeries(d.binance, d.delta, direction);
    const funding = bybit
      ? dailyFunding(d.binance, d.bybit, direction)
      : dailyFunding(d.binance, d.delta, direction);
    // Dynamic flip: replays every payment, swaps sides when a losing streak reaches the threshold (see lib/calc.ts).
    const dyn = bybit
      ? dynamicFlip(d.binance, d.bybit, roundTripFeeFor("bybit"), [BYBIT_DIR_A, BYBIT_DIR_B])
      : dynamicFlip(d.binance, d.delta, roundTripFeeFor("delta"));
    const dynByDate = new Map((dyn?.daily ?? []).map((x) => [x.date, x]));
    const merged = series.map((r: any) => { const x = dynByDate.get(r.date); return x ? { ...r, dyn_earn: x.earn * 100, dyn_cumulative: x.cumulative * 100, dyn_direction: x.direction } : r; });
    const { daily: _daily, ...dynSummary } = dyn ?? ({} as any);
    return Response.json({ pair: d.pair, series: merged, funding, dyn: dyn ? dynSummary : null, market: bybit ? "bybit" : "delta" },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}