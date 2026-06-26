/**
 * Deterministic signal projections, the evidence-layer rollups the loader
 * writes alongside each event in the same SQLite transaction.
 *
 * Each projection is a pure function from event to one or more upserts
 * against a signal table named in ADR-0006. The writer calls
 * `projectSignals` only when the event's INSERT OR IGNORE actually inserted
 * a new row, so a replay of the same event hash does not double-project.
 *
 * The signals materialized here cross multiple events (per-conversation
 * rollups, paired tool spans) or anchor a hot sort key. Single-event
 * aggregations (prompt count, tool count, compaction count) are exposed as
 * the `conversation_counts` SQL view created in migration v2; they are not
 * materialized.
 */
import type { Database } from "bun:sqlite";
import type { RegimenEvent } from "../../hooks/event-log.ts";

export function projectSignals(db: Database, event: RegimenEvent): void {
  bumpConversation(db, event);
  if (event.event_type === "tool.pre") {
    openToolSpan(db, event);
    recordSkillInvocation(db, event);
  }
  if (event.event_type === "tool.post") closeToolSpan(db, event);
}

/**
 * A tool.pre that names a skill bumps the (session_id, skill_name) row, so the
 * evidence layer can report which skills a conversation invoked and how often.
 * Counted on the invocation (tool.pre), not the completion (tool.post), so a
 * single skill call counts once even though both phases carry skill_name.
 */
function recordSkillInvocation(db: Database, event: RegimenEvent): void {
  const skillName = event.attributes.skill_name;
  if (skillName === undefined) return;
  db.prepare(
    `INSERT INTO skill_invocations (session_id, skill_name, invocation_count, last_invoked_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(session_id, skill_name) DO UPDATE SET
       invocation_count = invocation_count + 1,
       last_invoked_at = excluded.last_invoked_at`,
  ).run(event.session_id, skillName, event.timestamp);
}

function closeToolSpan(db: Database, event: RegimenEvent): void {
  const toolCallId = event.attributes.tool_call_id;
  if (toolCallId === undefined) return;
  db.prepare(
    `UPDATE tool_call_spans
       SET ended_at = ?,
           duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE session_id = ? AND tool_call_id = ?`,
  ).run(event.timestamp, event.timestamp, event.session_id, toolCallId);
  recordFileEdit(db, event);
}

const FILE_EDITING_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "apply_patch",
]);

/**
 * tool.post for a file-mutating tool that names a file_path bumps the
 * (session_id, file_path) row. The set is the conservative, harness-agnostic
 * read of "file-edit churn": tools that mutate file contents, whatever the
 * harness calls them (Claude's Edit/Write, Codex's apply_patch). A tool that
 * merely names a file without mutating it (Read) is excluded. The rollout
 * reader emits one such tool.post per file an apply_patch touched, so a
 * multi-file patch churns each file it changed.
 */
function recordFileEdit(db: Database, event: RegimenEvent): void {
  const toolName = event.attributes.tool_name;
  const filePath = event.attributes.file_path;
  if (toolName === undefined || !FILE_EDITING_TOOLS.has(toolName)) return;
  if (filePath === undefined) return;
  db.prepare(
    `INSERT INTO repeated_file_edits (session_id, file_path, edit_count, last_edited_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(session_id, file_path) DO UPDATE SET
       edit_count = edit_count + 1,
       last_edited_at = excluded.last_edited_at`,
  ).run(event.session_id, filePath, event.timestamp);
}

function openToolSpan(db: Database, event: RegimenEvent): void {
  const toolCallId = event.attributes.tool_call_id;
  const toolName = event.attributes.tool_name;
  if (toolCallId === undefined || toolName === undefined) return;
  db.prepare(
    `INSERT OR IGNORE INTO tool_call_spans
       (session_id, tool_call_id, tool_name, started_at, ended_at, duration_ms)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run(event.session_id, toolCallId, toolName, event.timestamp);
}

/**
 * Upsert the conversation rollup. Every event bumps `last_event_at` (and
 * `first_event_at` if it predates the existing minimum); session.start and
 * session.end pin their respective timestamps on the row. A session.end also
 * records the native and normalized end reason it carries, so a reader sees
 * how a session ended (a deliberate exit versus an abrupt or abandoned one)
 * without re-deriving it from raw events. The working directory is pinned
 * first-wins (the earliest event that carried one), so it anchors to where the
 * session opened rather than drifting if the agent later changed directories.
 * COALESCE preserves the first session.start, session.end, end reason, or cwd
 * if a later event ever races them.
 */
function bumpConversation(db: Database, event: RegimenEvent): void {
  const isEnd = event.event_type === "session.end";
  const startedAt =
    event.event_type === "session.start" ? event.timestamp : null;
  const endedAt = isEnd ? event.timestamp : null;
  const endReasonNative = isEnd
    ? (event.attributes.end_reason_native ?? null)
    : null;
  const endReasonNormalized = isEnd
    ? (event.attributes.end_reason_normalized ?? null)
    : null;

  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, cwd, session_started_at, session_ended_at,
        session_end_reason_native, session_end_reason_normalized, first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       model = COALESCE(excluded.model, conversations.model),
       cwd = COALESCE(conversations.cwd, excluded.cwd),
       session_started_at = COALESCE(conversations.session_started_at, excluded.session_started_at),
       session_ended_at = COALESCE(conversations.session_ended_at, excluded.session_ended_at),
       session_end_reason_native = COALESCE(conversations.session_end_reason_native, excluded.session_end_reason_native),
       session_end_reason_normalized = COALESCE(conversations.session_end_reason_normalized, excluded.session_end_reason_normalized),
       first_event_at = MIN(conversations.first_event_at, excluded.first_event_at),
       last_event_at = MAX(conversations.last_event_at, excluded.last_event_at)`,
  ).run(
    event.session_id,
    event.harness,
    event.model ?? null,
    event.cwd ?? null,
    startedAt,
    endedAt,
    endReasonNative,
    endReasonNormalized,
    event.timestamp,
    event.timestamp,
  );
}
