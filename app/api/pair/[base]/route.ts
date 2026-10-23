import { getPairDetail } from "@/lib/queries";
import { chartSeries, DIR_A } from "@/lib/calc";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ base: string }> }) {
  const { base } = await params;
  try {
    const d = await getPairDetail(base.toUpperCase());
    if (!d) return Response.json({ error: "unknown pair" }, { status: 404 });
    const direction = d.pair.direction ?? DIR_A;
    return Response.json({ pair: d.pair, series: chartSeries(d.binance, d.delta, direction) },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}
