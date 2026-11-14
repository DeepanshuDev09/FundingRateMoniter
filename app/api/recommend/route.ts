import { getRecommendations } from "@/lib/recommend";
import { getDynamicRecommendations } from "@/lib/recommendDynamic";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    // One market (or the dynamic analysis) failing must not take the others down with it.
    const [d, y, dd, dy] = await Promise.allSettled([getRecommendations("delta"), getRecommendations("bybit"), getDynamicRecommendations("delta"), getDynamicRecommendations("bybit")]);
    if (d.status === "rejected" && y.status === "rejected") throw d.reason;
    const val = (r: PromiseSettledResult<any>) => (r.status === "fulfilled" ? r.value : null);
    const err = (r: PromiseSettledResult<any>) => (r.status === "rejected" ? String((r.reason as any)?.message ?? r.reason) : null);
    return Response.json({
      delta: val(d), bybit: val(y), dynDelta: val(dd), dynBybit: val(dy),
      errors: { delta: err(d), bybit: err(y), dynDelta: err(dd), dynBybit: err(dy) },
    }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}