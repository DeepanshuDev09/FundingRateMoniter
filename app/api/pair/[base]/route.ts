import { getPairDetail } from "@/lib/queries";
import { BYBIT_DIR_A, chartSeries, DIR_A } from "@/lib/calc";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ base: string }> }) {
  const { base } = await params;
  try {
    const d = await getPairDetail(base.toUpperCase());
    if (!d) return Response.json({ error: "unknown pair" }, { status: 404 });
    // ?market=bybit shows the Binance <-> Bybit view of the same pair.
    const bybit = new URL(req.url).searchParams.get("market") === "bybit";
    const series = bybit
      ? chartSeries(d.binance, d.bybit, d.pair.y_direction ?? d.pair.y_live_direction ?? BYBIT_DIR_A, ["binance", "bybit"])
      : chartSeries(d.binance, d.delta, d.pair.direction ?? DIR_A);
    return Response.json({ pair: d.pair, series, market: bybit ? "bybit" : "delta" },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}
