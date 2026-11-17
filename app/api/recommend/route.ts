import { getRecommendations } from "@/lib/recommend";
import { getDynamicRecommendations } from "@/lib/recommendDynamic";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    // One market (or the dynamic analysis) failing must not take the others down with it.
    const [d, y, yd, dd, dy, dyd] = await Promise.allSettled([
      getRecommendations("delta"), getRecommendations("bybit"), getRecommendations("bybit-delta"),
      getDynamicRecommendations("delta"), getDynamicRecommendations("bybit"), getDynamicRecommendations("bybit-delta"),
    ]);
    if ([d, y, yd].every((r) => r.status === "rejected")) throw d.status === "rejected" ? d.reason : new Error("Could not load recommendation data");
    const val = (r: PromiseSettledResult<any>) => (r.status === "fulfilled" ? r.value : null);
    const err = (r: PromiseSettledResult<any>) => (r.status === "rejected" ? String((r.reason as any)?.message ?? r.reason) : null);
    return Response.json({
      delta: val(d), bybit: val(y), bybitDelta: val(yd),
      dynDelta: val(dd), dynBybit: val(dy), dynBybitDelta: val(dyd),
      errors: {
        delta: err(d), bybit: err(y), bybitDelta: err(yd),
        dynDelta: err(dd), dynBybit: err(dy), dynBybitDelta: err(dyd),
      },
    }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}