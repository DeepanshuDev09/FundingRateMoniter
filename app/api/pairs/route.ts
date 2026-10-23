import { getPairs } from "@/lib/queries";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const data = await getPairs();
    return Response.json(data, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}
