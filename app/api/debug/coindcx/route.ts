import { isAdmin } from "@/lib/auth";
import { coindcxRaw } from "@/lib/exchanges";
export const dynamic = "force-dynamic";
/** Raw CoinDCX payload sample to confirm the funding field and interval. Send header x-admin-password. ?pair=B-BTC_USDT */
export async function GET(req: Request) {
  if (!isAdmin(req)) return new Response("unauthorized", { status: 401 });
  const pair = new URL(req.url).searchParams.get("pair") ?? "B-BTC_USDT";
  try { return Response.json(await coindcxRaw(pair)); }
  catch (e: any) { return Response.json({ error: String(e.message) }, { status: 500 }); }
}