/**
 * resolveCopilotSession behavior. Copilot CLI exposes the live session id to the
 * agent's shell via COPILOT_AGENT_SESSION_ID, so resolution is a direct env
 * read: no per-cwd stamp and no newest-by-mtime scan. Absent or empty, it
 * returns null (the fail-closed "no current session" signal).
 */
import { expect, test } from "bun:test";
import {
  COPILOT_SESSION_ID_ENV,
  resolveCopilotSession,
} from "../src/copilot/resolve-session.ts";

const SESSION = "e2ba254f-5455-47e2-aa80-1bc2706d7294";

test("the current session id is read directly from COPILOT_AGENT_SESSION_ID", () => {
  expect(resolveCopilotSession({ [COPILOT_SESSION_ID_ENV]: SESSION })).toBe(
    SESSION,
  );
});

test("an unset session-id env var resolves to null (no current session)", () => {
  expect(resolveCopilotSession({})).toBeNull();
});

test("an empty session-id env var resolves to null rather than the empty string", () => {
  expect(resolveCopilotSession({ [COPILOT_SESSION_ID_ENV]: "" })).toBeNull();
});
