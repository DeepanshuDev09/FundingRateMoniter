import { getPairs } from "@/lib/queries";
export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await getPairs();
  const cols = ["base","direction","live_apr","ret7","ret30","net30","ret90","net90","apr","trend3_apr","consistency","spread_std","sign_flips","basis","volume","d_oi","breakeven_days","last_synced_at"];
  const csv = [cols.join(","), ...rows.map((r: any) => cols.map((c) => r[c] ?? "").join(","))].join("\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=funding-spreads.csv" } });
}