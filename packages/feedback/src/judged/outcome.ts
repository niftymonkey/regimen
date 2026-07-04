/**
 * The write-time derivation of the Outcome read-key from the two judged axes
 * (ADR-0017). Outcome is no longer a primitive the judge emits directly; it is
 * a function of `accomplishment` (done-ness) and `correction-cost` (steering),
 * computed by the writer so the four `signal_name='outcome'` read sites and the
 * `--outcome` filter keep returning a scored worst-to-best spectrum.
 *
 * Judged-from-judged, never a copied deterministic operand: the derived value is
 * a pure function of two judged values, so ADR-0008's no-copied-operand rule
 * holds. `correction-cost` abstains on any non-accomplished result (the floor
 * already absorbs steering), so it is optional here and ignored unless the
 * assignment was accomplished.
 */
import type { AccomplishmentValue, CorrectionCostValue } from "./types.ts";

/** The five-value derived Outcome spectrum, worst to best (ADR-0017). */
export type DerivedOutcomeValue =
  | "not-accomplished"
  | "partial"
  | "accomplished-under-heavy-correction"
  | "accomplished-under-light-correction"
  | "accomplished-cleanly";

/**
 * Derive the Outcome read-key from the two judged axes. `not-accomplished` maps
 * to the floor and `partial` to the middle (correction-cost is ignored there,
 * having abstained); an `accomplished` result maps by its correction-cost:
 * `heavy` and `light` to the two under-correction values, `none` (or an absent
 * cost) to the clean top.
 */
export function deriveOutcome(
  accomplishment: AccomplishmentValue,
  correctionCost?: CorrectionCostValue,
): DerivedOutcomeValue {
  if (accomplishment === "not-accomplished") return "not-accomplished";
  if (accomplishment === "partial") return "partial";
  if (correctionCost === "heavy") return "accomplished-under-heavy-correction";
  if (correctionCost === "light") return "accomplished-under-light-correction";
  return "accomplished-cleanly";
}
