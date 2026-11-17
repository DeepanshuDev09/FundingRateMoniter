import { getPairDetail } from "@/lib/queries";
import { BYBIT_DELTA_DIR_A, BYBIT_DELTA_DIR_B, BYBIT_DIR_A, BYBIT_DIR_B, chartSeries, dailyFunding, DIR_A, dynamicFlip, roundTripFeeFor } from "@/lib/calc";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ base: string }> }) {
  const { base } = await params;
  try {
    const d = await getPairDetail(base.toUpperCase());
    if (!d) return Response.json({ error: "unknown pair" }, { status: 404 });
    // ?market=bybit shows the Binance <-> Bybit view of the same pair.
    const market = new URL(req.url).searchParams.get("market");
    const bybit = market === "bybit";
    const bybitDelta = market === "bybit-delta";
    const direction = bybit
      ? d.pair.y_direction ?? d.pair.y_live_direction ?? BYBIT_DIR_A
      : bybitDelta
        ? d.pair.yd_direction ?? d.pair.yd_live_direction ?? BYBIT_DELTA_DIR_A
        : d.pair.direction ?? DIR_A;
    const left = bybitDelta ? d.bybit : d.binance;
    const right = bybit ? d.bybit : d.delta;
    const series = bybitDelta
      ? chartSeries(left, right, direction, ["bybit", "delta"])
      : bybit
        ? chartSeries(left, right, direction, ["binance", "bybit"])
        : chartSeries(left, right, direction);
    const funding = dailyFunding(left, right, direction);
    // Dynamic flip: replays every payment, swaps sides when a losing streak reaches the threshold (see lib/calc.ts).
    const dyn = bybitDelta
      ? dynamicFlip(left, right, 2 * (Number(process.env.TAKER_FEE_BYBIT ?? 0.00055) + Number(process.env.TAKER_FEE_DELTA ?? 0.0005)), [BYBIT_DELTA_DIR_A, BYBIT_DELTA_DIR_B])
      : bybit
        ? dynamicFlip(left, right, roundTripFeeFor("bybit"), [BYBIT_DIR_A, BYBIT_DIR_B])
        : dynamicFlip(left, right, roundTripFeeFor("delta"));
    const dynByDate = new Map((dyn?.daily ?? []).map((x) => [x.date, x]));
    const merged = series.map((r: any) => { const x = dynByDate.get(r.date); return x ? { ...r, dyn_earn: x.earn * 100, dyn_cumulative: x.cumulative * 100, dyn_direction: x.direction } : r; });
    const { daily: _daily, ...dynSummary } = dyn ?? ({} as any);
    return Response.json({ pair: d.pair, series: merged, funding, dyn: dyn ? dynSummary : null, market: bybitDelta ? "bybit-delta" : bybit ? "bybit" : "delta" },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e: any) {
    return Response.json({ error: String(e.message) }, { status: 500 });
  }
}