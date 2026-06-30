/**
 * The engineer's setup as the judge weighs it: the stated conventions and the
 * established practices that stand as expected behaviors for a conversation.
 *
 * Everything here is normalized harness- and model-neutrally at the adapter
 * edge, so nothing names a file, a harness, or a model. `scope` carries
 * provenance generically (project versus global), never a file name. The
 * `SetupSource` port is the seam a later unit's adapter implements and the
 * assess orchestrator consumes; this module defines the contract only.
 */

/** One block of the engineer's stated conventions, provenance-tagged generically. */
export interface ConventionSource {
  readonly scope: "project" | "global";
  readonly text: string;
}

/** One of the engineer's established practices, by name and one-line summary. */
export interface EstablishedPractice {
  readonly name: string;
  readonly summary: string;
}

/**
 * The engineer's normalized setup: the stated conventions and the established
 * practices the judge weighs as expected behaviors. Carries no file name and no
 * harness or model identity.
 */
export interface EngineerSetup {
  readonly conventions: ReadonlyArray<ConventionSource>;
  readonly practices: ReadonlyArray<EstablishedPractice>;
}

/**
 * The port that yields the engineer's setup in force as of a conversation's
 * time. The adapter (a later unit) implements it; the judge consumes it.
 * `resolve` returns undefined when no setup is discoverable, and the judge then
 * falls back to its setup-blind baseline.
 */
export interface SetupSource {
  resolve(input: {
    readonly cwd?: string;
    readonly asOf: Date;
  }): EngineerSetup | undefined;
}
