import { getRecommendations } from "@/lib/recommend";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    // One market failing must not take the other down with it.
    const [d, y] = await Promise.allSettled([getRecommendations("delta"), getRecommendations("bybit")]);
    if (d.status === "rejected" && y.status === "rejected") throw d.reason;
    return Response.json({
      delta: d.status === "fulfilled" ? d.value : null, bybit: y.status === "fulfilled" ? y.value : null,
      errors: { delta: d.status === "rejected" ? String(d.reason?.message ?? d.reason) : null, bybit: y.status === "rejected" ? String(y.reason?.message ?? y.reason) : null },
    }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}
