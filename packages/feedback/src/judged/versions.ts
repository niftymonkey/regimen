/**
 * The single source of truth for the judge's version stamps.
 *
 * `RUBRIC_VERSION` and `PROMPT_VERSION` are the date-stamped provenance the
 * Judge and the assess orchestrator stamp on every run. Both the judge's
 * defaults and the orchestrator's insufficient-evidence path read them here, so
 * a version bump is single-sourced (one edit, not two copies kept in sync).
 */

/** The rubric's version stamp (the date-stamped scheme of spec section 9.3). */
export const RUBRIC_VERSION = "2026-06-29";

/** The prompt template's version stamp (the same date-stamped scheme). */
export const PROMPT_VERSION = "2026-06-29";
