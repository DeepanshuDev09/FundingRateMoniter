import { getRecommendations } from "@/lib/recommend";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await getRecommendations(), { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}