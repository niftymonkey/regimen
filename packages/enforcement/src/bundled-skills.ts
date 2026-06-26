/**
 * The skills the Enforcement package bundles, by their
 * `<home>/<skillsSubdir>/<name>/` directory. `regimen-enforcement` is the
 * act-beat operator skill: the respond-step helper that authors and wires a
 * deterministic mechanism when a Feedback pattern shows asking has failed. The
 * package's install passes this list to the shared bundler so it bundles only its
 * own skill from its own clone, the way Feedback's install bundles `BUNDLED_SKILLS`.
 * Adding another Enforcement skill is one entry here, not a new code path.
 */
export const BUNDLED_SKILLS = ["regimen-enforcement"] as const;
