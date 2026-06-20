/**
 * resolveClaudeSession behavior. Claude Code exposes the live session id to the
 * agent's shell via CLAUDE_CODE_SESSION_ID, so resolution is a direct env read:
 * no per-cwd stamp and no newest-by-mtime scan. Absent or empty, it returns null
 * (the fail-closed "no current session" signal).
 */
import { expect, test } from "bun:test";
import {
  CLAUDE_SESSION_ID_ENV,
  resolveClaudeSession,
} from "../src/claude/resolve-session.ts";

const SESSION = "08551ace-1f3c-40b2-a088-ef00ce37027f";

test("the current session id is read directly from CLAUDE_CODE_SESSION_ID", () => {
  expect(resolveClaudeSession({ [CLAUDE_SESSION_ID_ENV]: SESSION })).toBe(
    SESSION,
  );
});

test("an unset session-id env var resolves to null (no current session)", () => {
  expect(resolveClaudeSession({})).toBeNull();
});

test("an empty session-id env var resolves to null rather than the empty string", () => {
  expect(resolveClaudeSession({ [CLAUDE_SESSION_ID_ENV]: "" })).toBeNull();
});
