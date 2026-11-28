/**
 * Why do two exchanges show different funding for the same coin?
 * Funding is not a market price. Each exchange computes it from ITS OWN premium (its perpetual price versus ITS OWN index price),
 * then runs it through its own formula (Delta: Funding = AvgPremium + clamp(Interest - AvgPremium, -0.05%, +0.05%), interest 0.01% per 8h).
 * Inverting that formula tells us what premium a funding rate implies. Comparing it with the premium actually visible on the
 * exchange shows whether the funding is explained by a real price discount/premium, or by a cap, an index problem or a formula quirk.
 */
export type Leg = { rate: number | null; interval: number | null; mark: number | null; index: number | null; cap?: number | null; floor?: number | null };

const BAND = 0.0005;       // the clamp band, +-0.05%
const INTEREST_8H = 0.0001; // 0.01% per 8 hours

/** Premium implied by a funding rate. If the rate equals the interest rate, the premium is only known to lie inside a band. */
export function impliedPremium(rate: number, intervalH: number, o: { scaleBand?: boolean } = {}) {
  const I = (INTEREST_8H * intervalH) / 8;
  const band = o.scaleBand ? (BAND * intervalH) / 8 : BAND;
  if (Math.abs(rate - I) < 1e-9) return { kind: "band" as const, lo: I - band, hi: I + band, mid: I };
  const p = rate < I ? rate - band : rate + band;   // premium so low (or high) that the clamp is active
  return { kind: "exact" as const, lo: p, hi: p, mid: p };
}

export type Check = "consistent" | "mismatch" | "capped" | "unknown";
export function diagnoseLeg(leg: Leg) {
  const premium = leg.mark && leg.index ? leg.mark / leg.index - 1 : null;
  const implied = leg.rate != null && leg.interval ? impliedPremium(leg.rate, leg.interval) : null;
  const atCap = leg.rate != null && (
    (leg.cap != null && leg.cap > 0 && leg.rate >= 0.98 * leg.cap) ||
    (leg.floor != null && leg.floor < 0 && leg.rate <= 0.98 * leg.floor));
  let status: Check = "unknown";
  if (atCap) status = "capped";
  else if (premium != null && implied) {
    // The live premium is one instant, funding is an average over the interval, so the test is deliberately loose.
    const ok = implied.kind === "band"
      ? premium >= implied.lo - 0.0005 && premium <= implied.hi + 0.0005
      : Math.abs(premium - implied.mid) <= Math.max(0.0003, 0.5 * Math.abs(implied.mid));
    status = ok ? "consistent" : "mismatch";
  }
  return { premium, implied, status, atCap, cap: leg.cap ?? null, floor: leg.floor ?? null };
}

export const CHECK_LABEL: Record<Check, string> = { consistent: "Matches its price gap", mismatch: "Does not match", capped: "At funding cap", unknown: "No data" };

/** Bybit is switching contracts with a funding interval under 8h to a formula scaled by N/8 in three batches. */
export const BYBIT_FORMULA_NOTE =
  "Bybit is moving contracts with a funding interval under 8 hours to a new formula (rate scaled by N/8) in batches on Nov 24, Nov 26 and Dec 1, 2026. " +
  "Check this symbol on Bybit's rollout list. Per-payment rates before and after its date are not comparable.";