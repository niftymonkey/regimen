/**
 * The skills the Guidance package bundles, by their
 * `<home>/<skillsSubdir>/<name>/` directory. `guidance-respond` is the act-beat
 * operator skill: the respond-step helper that finds, builds, or reaches for an
 * advisory move when a Feedback pattern surfaces and asking can plausibly work.
 * The package's install passes this list to the shared bundler so it bundles only
 * its own skill from its own clone, the way Feedback's install bundles
 * `BUNDLED_SKILLS` and Enforcement's bundles `enforcement-respond`. Adding another
 * Guidance skill is one entry here, not a new code path.
 */
export const BUNDLED_SKILLS = ["guidance-respond"] as const;
