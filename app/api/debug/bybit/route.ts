import { isAdmin } from "@/lib/auth";
import { bybitRaw } from "@/lib/exchanges";
export const dynamic = "force-dynamic";
/** Shows which Bybit host answers from this Vercel region. Send header x-admin-password. ?symbol=BTCUSDT */
export async function GET(req: Request) {
  if (!isAdmin(req)) return new Response("unauthorized", { status: 401 });
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT";
  try { return Response.json(await bybitRaw(symbol)); }
  catch (e: any) { return Response.json({ error: String(e.message) }, { status: 500 }); }
}
