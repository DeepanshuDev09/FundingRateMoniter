import { q } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await q(`SELECT base,binance_symbol,delta_symbol,b_mult,d_mult FROM pair_map WHERE active ORDER BY base`);
  return Response.json(rows, { headers: { "Content-Disposition": "attachment; filename=common_pairs.json" } });
}
