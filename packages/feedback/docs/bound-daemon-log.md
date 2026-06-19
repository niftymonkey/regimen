# Plan: Bound the daemon log's growth

> Source: GitHub issue #18 (niftymonkey/regimen-feedback).

## Context

The Feedback daemon writes an operational log (`daemon.log`) so an engineer can
see what it did: when it started, what it drained, when something went wrong.
Today that log is not daemon-owned. `src/loader/run.ts` writes plain lines to
`process.stdout`/`process.stderr`, and the OS service definition redirects that
stream into `<dataDir>/daemon.log` (systemd `append:`, launchd `StandardOutPath`,
Windows `>>`). Nothing rotates it. Worse, `run.ts`'s `onDrain` handler writes a
line per drain-with-activity, which in live operation is near per-event, so the
file grows continuously and is dominated by routine noise. The separate
`capture-errors.log`, written by `recordError` in `hooks/event-log.ts`, has the
same unbounded shape (it only grows on capture failure, but is still uncapped).

Feedback already bounds its JSONL buffer with daemon-owned rotation (PR #17). A
daemon-owned file that leaks disk indefinitely contradicts that hygiene. This
change makes the daemon own and bound both log files, and cuts `daemon.log` down
to a readable operational record: lifecycle, rotations, quarantines, anomalies,
and a periodic heartbeat instead of a per-drain firehose.

Intended outcome: both log files stay bounded under continuous long-running use,
and `daemon.log` reads as a useful operational record.

## Architectural decisions

Durable decisions (from an architect-deep design pass), applying across all
phases:

- **Two new modules.**
  - `src/rolling-log.ts` (shared leaf module, sits by `data-dir.ts`). A pure-ish
    filesystem primitive `rollIfOversize(path, { maxBytes, keep }): { rolled: boolean }`.
    At or over `maxBytes` it shifts `path` to `path.1` to `path.2` and onward,
    drops beyond `keep`, so the next append recreates `path`. Holds no inter-call
    state, best-effort, swallows errors. Two callers in two contexts: the
    operational logger (daemon side) and `recordError` (capture edge). This is
    same-writer roll-and-retain, deliberately distinct from `src/loader/rotator.ts`,
    which does producer/consumer sealing of the buffer.
  - `src/loader/operational-log.ts` (daemon-only, sits by `rotator.ts`/`driver.ts`).
    `openOperationalLog({ dataDir, heartbeatMs?, maxBytes?, keep?, now? })`
    returns named sink functions: `started()`, `ready()`, `shutdown(reason)`,
    `drain(result)`, `quarantined(count)`, `rotated(sealed)`,
    `anomaly(context, err)`, `heartbeat()`, `close()`. The logger owns the
    heartbeat interval timer and the `DrainResult` aggregation state. `drain()`
    accumulates in memory and writes nothing; the heartbeat emits the aggregated
    summary line and resets. `heartbeat()` is a real public method the internal
    timer calls, and also the deterministic test seam (no clock-waiting).
    `close()` flushes a pending heartbeat, stops the timer, and is idempotent.
- **`daemon.log` is daemon-owned.** The daemon writes it directly; OS service
  files redirect stdout/stderr to `/dev/null` (`NUL` on Windows) so the
  supervisor is not a second writer fighting rotation.
- **`ready\n` stays on `process.stdout`.** The readiness handshake is unchanged;
  `tests/loader-acceptance.test.ts` runs the daemon with a piped stdout and reads
  it directly, independent of the service redirect.
- **Format.** Plain text, one greppable entry per line: `<rfc3339> <kind> <k=v...>`.
  Stack traces are newline-escaped so an entry is always one line.
- **Best-effort.** Every logger sink and `rollIfOversize` swallow their own
  errors and never throw; a logging failure must not crash the daemon. The
  logger surfaces a write-failure count in the next heartbeat.
- **Driver stays pure.** `driver.ts` gains one optional `onRotate?` callback,
  symmetric with `onDrain`; no other driver change.
- **Defaults (tunable):** `maxBytes` ~1_000_000 and `keep` 3 for both log files;
  `heartbeatMs` 600_000 (10 min). Idle heartbeats (zero drains) are still emitted
  as a terse liveness signal.
- **Migration.** Engineers who already ran `feedback install-daemon` must re-run
  it after upgrading; it idempotently rewrites the service file that still
  redirects into `daemon.log`. This goes in the issue #18 follow-up comment.

---

## Phase 1: Bound `capture-errors.log`

**Acceptance criterion covered:** "The capture-error log is likewise bounded."

### What to build

The rolling-file primitive, plus its first real consumer, as one end-to-end
slice. Create `src/rolling-log.ts` exporting `rollIfOversize(path, { maxBytes, keep })`.
Wire it into `recordError` in `hooks/event-log.ts`: before the `appendFileSync`
to `capture-errors.log`, call `rollIfOversize` on that path, inside the existing
`try/catch` so it can never surface to a session. After this phase
`capture-errors.log` self-bounds whenever a capture failure is recorded.

### Critical files

- `src/rolling-log.ts` (new): the primitive. No injected seams; the local
  filesystem is the test substrate. Mirrors the pure-decision style of
  `src/loader/rotator.ts`.
- `hooks/event-log.ts`: `recordError` calls `rollIfOversize` before its append.
  Roll size reads `REGIMEN_CAPTURE_LOG_MAX_BYTES` (default 1_000_000), keep 3.
- `tests/rolling-log.test.ts` (new): under threshold is a no-op; at/over
  threshold rolls; missing file is a no-op; `keep` N drops the oldest; repeated
  rolls shift `.1`/`.2`/onward correctly.
- `tests/event-log.test.ts`: extend so `recordError` keeps `capture-errors.log`
  bounded (drive it past a tiny `maxBytes`, assert a `.1` copy appears).

### Acceptance criteria

- [x] `rollIfOversize` rolls a file at/over `maxBytes`, retaining `keep` copies.
- [x] `recordError` keeps `capture-errors.log` bounded under repeated failures.
- [x] A roll or stat failure never throws out of `rollIfOversize` or `recordError`.
- [x] `bun run check` is green.

---

## Phase 2: The operational logger module

**Acceptance criteria covered:** none closed directly; this is the engine for
AC1 and AC3.

### What to build

`src/loader/operational-log.ts` exporting `openOperationalLog(config)`. The
returned object exposes the named sinks listed in Architectural decisions.
Behind the seam: the heartbeat `setInterval` (which calls the public
`heartbeat()`), the `DrainResult` aggregator (drain count plus summed
`segments_read`, `lines_read`, `events_inserted`, `events_already_present`,
`events_skipped`, `quarantined`, plus window start), plain-text line formatting
with an injected clock, a `rollIfOversize` call before each append, a
roll-notice line written first into a freshly rolled file, a write-failure
counter surfaced in the next heartbeat, and best-effort try/catch around every
filesystem touch. Not yet wired into the running daemon.

### Critical files

- `src/loader/operational-log.ts` (new): depends on `src/rolling-log.ts` and
  `DrainResult` from `src/loader/drain.ts`. One internal seam: injectable `now`,
  mirroring `rotator.ts`.
- `tests/operational-log.test.ts` (new): exercise the module through its
  interface against a temp dir with an injected `now`: each writing sink emits
  one correctly-formatted line; `drain()` writes nothing; `heartbeat()` emits a
  line with summed counts and a window span, then resets; `close()` flushes a
  pending heartbeat and is idempotent; crossing `maxBytes` produces a `.1` copy
  and a roll-notice line in the fresh file; `anomaly()` keeps a stack trace on
  one line. `rollIfOversize` internals are not re-tested here.

### Acceptance criteria

- [x] Every sink writes (or, for `drain()`, defers) as specified, and none throw.
- [x] `heartbeat()` emits one aggregated line and resets the aggregator; the
      internal timer and a direct test call produce identical behavior.
- [x] `close()` flushes any pending heartbeat, stops the timer, and is idempotent.
- [x] `daemon.log` stays bounded as the logger writes past `maxBytes`.
- [x] `bun run check` is green.

---

## Phase 3: The daemon owns `daemon.log`

**Acceptance criteria covered:** "The daemon log stays bounded in size" and
"The daemon log reads as a useful operational record."

### What to build

Wire the logger into the running daemon and stop the OS supervisor from writing
`daemon.log`. The driver surfaces buffer rotation; `run.ts` constructs the
logger and routes every operational event through it; the three install writers
redirect stdout/stderr away from `daemon.log`.

### Critical files

- `src/loader/driver.ts`: add `onRotate?: (sealed: string) => void` to
  `DriverOptions`; in `runCycle`, when `rotation.kind === "rotated"`, call
  `opts.onRotate?.(rotation.sealed)`. `scheduleCycle()` behavior unchanged. The
  driver stays pure.
- `src/loader/run.ts`: construct `openOperationalLog({ dataDir: dir })` early.
  `log.started()` at startup. The watcher-ready callback keeps
  `process.stdout.write("ready\n")` and adds `log.ready()`. `onDrain` becomes
  `(r) => { log.drain(r); if (r.quarantined > 0) log.quarantined(r.quarantined); }`.
  Add `onRotate: (sealed) => log.rotated(sealed)`. In `shutdown`, replace the
  `process.stdout.write("shutting down: ...")` with `log.shutdown(reason)`,
  replace the catch's `recordError(err)` with `log.anomaly("driver shutdown", err)`,
  and call `log.close()` before `process.exit`. The per-drain `drained ...`
  stdout block is deleted. The top-level `main().catch()` keeps `recordError` as
  the catastrophic-boot backstop, now bounded by Phase 1.
- `src/cli/install/linux.ts`: `StandardOutput`/`StandardError` set to `null`
  instead of `append:.../daemon.log`.
- `src/cli/install/macos.ts`: `StandardOutPath`/`StandardErrorPath` set to
  `/dev/null`.
- `src/cli/install/windows.ts`: redirect changes from `>> "...daemon.log" 2>&1`
  to `> NUL 2>&1`.
- `tests/driver.test.ts`: add coverage that `onRotate` fires with the sealed
  segment path when a rotation occurs.
- `tests/install-linux.test.ts`, `tests/install-macos.test.ts`, and
  `tests/install-windows.test.ts`: update the assertions that expect a
  `daemon.log` redirect to expect the `null`/`/dev/null`/`NUL` target.
- `tests/loader-acceptance.test.ts`: still passes on `ready\n`; add an
  assertion that after running, `daemon.log` contains a `started`/`ready`
  lifecycle line and no per-drain line.

### Acceptance criteria

- [x] The running daemon writes `daemon.log` itself; it contains lifecycle,
      rotation, quarantine, anomaly, and periodic heartbeat entries.
- [x] `daemon.log` contains no per-drain line; routine drain activity appears
      only in heartbeats.
- [x] `daemon.log` stays bounded as the daemon runs (the logger rolls it).
- [x] Install service definitions no longer redirect stdout/stderr into
      `daemon.log`.
- [x] `ready\n` still appears on the daemon's stdout; `loader-acceptance` passes.
- [x] `bun run check` is green.

---

## Phase 4: `purge --all` extends to the logs

**Acceptance criteria covered:** rounds out the hygiene story for AC1/AC2.

### What to build

Extend `purge` in `src/cli/index.ts` so that `feedback purge --all` also removes
`daemon.log`, `capture-errors.log`, and their rolled copies (`.1`, `.2`, and
onward). `purge` without `--all` is unchanged (buffer only). Operational logs
are removed only under the explicit full-reset flag.

### Critical files

- `src/cli/index.ts`: in `purge`, when `includeStore` is set, also `rmSync`
  every `daemon.log*` and `capture-errors.log*` in the data dir (read the
  directory and match the two prefixes). Print a confirmation line.
- `tests/cli.test.ts`: extend the `purge --all` test to seed `daemon.log`, a
  `daemon.log.1`, and `capture-errors.log`, and assert all are removed; confirm
  a plain `purge` leaves them in place.

### Acceptance criteria

- [x] `feedback purge --all` removes `daemon.log`, `capture-errors.log`, and
      their rolled copies.
- [x] `feedback purge` (no `--all`) leaves both log files untouched.
- [x] `bun run check` is green.

---

## Verification

- **Each phase:** `bun run check` (typecheck, eslint, prettier check, `bun test`)
  must be green before the phase is considered done.
- **Phase 1:** `tests/rolling-log.test.ts` and the extended
  `tests/event-log.test.ts` pass.
- **Phase 2:** `tests/operational-log.test.ts` passes.
- **Phase 3:** `tests/loader-acceptance.test.ts` passes. Manual check: with
  `REGIMEN_DATA_DIR` set and feedback enabled, run `bun src/loader/run.ts`,
  drive some events through the buffer, and confirm `daemon.log` shows a
  `started`/`ready` line and a heartbeat, with no per-drain firehose. Run
  `feedback install-daemon --dry-run` and confirm the service content redirects
  to `null`/`/dev/null`/`NUL`, not `daemon.log`.
- **Phase 4:** the extended `tests/cli.test.ts` passes. Manual check:
  `feedback purge --all` removes both log files; `feedback purge` does not.

## Post-implementation

- Post a follow-up comment on issue #18 with the migration note (re-run
  `feedback install-daemon` after upgrading) and the chosen size/retention
  defaults, per the project's GitHub-issue convention (implementation context
  lives in a comment, not the issue body).
