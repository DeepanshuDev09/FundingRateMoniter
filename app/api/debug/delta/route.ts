import { isAdmin } from "@/lib/auth";
import { deltaRaw } from "@/lib/exchanges";
export const dynamic = "force-dynamic";
/** Raw Delta payloads to confirm funding units/interval. Send header x-admin-password. ?symbol=BTCUSD */
export async function GET(req: Request) {
  if (!isAdmin(req)) return new Response("unauthorized", { status: 401 });
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "BTCUSD";
  try { return Response.json(await deltaRaw(symbol)); }
  catch (e: any) { return Response.json({ error: String(e.message) }, { status: 500 }); }
}
