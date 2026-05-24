# Feedback operational health

> Status: draft, 2026-05-22. Specifies what "healthy" means for the Feedback instrument itself, and what an enriched `feedback status` should surface. Not yet implemented; this is the design input for that work.
>
> This document is about the *plumbing*: is capture running, is the store fresh, is disk bounded, has cleanup happened. It is not about what Feedback tells you about your AI work; that is [`feedback-surfacing.md`](feedback-surfacing.md). A healthy instrument is the precondition for trusting any signal Feedback surfaces, so the two are separate concerns and separate surfaces.

## Why this document

`feedback status` today answers four things: whether Feedback is enabled, whether the daemon process is running, when the last event arrived, and how many bytes are buffered. That is enough to know the instrument is *on*. It is not enough to know it is *well*.

Feedback is an always-on background daemon, plus a capture hook on every session, plus an optional export bridge, and all three write files into one shared data directory. Each can be running and still be unhealthy: the daemon drained behind, a log leaking disk, capture silently dropping events, the bridge failing every export. An instrument that quietly degrades is worse than one that is plainly off, because the engineer keeps trusting it. Regimen exists to model good hygiene; its own status surface should make that hygiene visible, not assume it.

This document enumerates every operational health dimension worth caring about, what a healthy and an unhealthy reading look like for each, and a proposed shape for an enriched `feedback status`.

It lives in the hub, not in `regimen-feedback`, deliberately. The files that can go wrong are written by two separate repos (`regimen-feedback` and `regimen-otlp-bridge`), and neither can own the comprehensive picture alone. Health is a cross-instrument concern, so it is documented at the program level.

## The system being watched

Three writers put files into one Regimen data directory:

- **The capture hook** (`regimen-feedback`) runs inside every agent session. It appends event envelopes to the buffer, and on its own failure appends to a capture-error log. It never reads the store and never knows the daemon exists.
- **The loader daemon** (`regimen-feedback`) follows the buffer in near-real-time, translates each envelope into a canonical event, writes it into the SQLite store, and writes its own operational log. It owns buffer rotation and store maintenance.
- **The OTLP bridge** (`regimen-otlp-bridge`, optional) reads the store read-only and streams signals to Grafana Cloud. It writes per-stream delivery cursors and its own log.

The data directory is `$XDG_DATA_HOME/regimen` or `~/.local/share/regimen` on Linux, `~/Library/Application Support/regimen` on macOS, and `%APPDATA%\regimen` on Windows; `REGIMEN_DATA_DIR` overrides all of them. Its full contents:

| Path | Written by | What it is | Bounded by | Healthy reading |
|---|---|---|---|---|
| `feedback.enabled` | `feedback start` / `stop` | the enabled flag; gates both capture and the daemon | n/a (empty file) | present when Feedback is on |
| `buffer/current.jsonl` | capture hook | the active append segment | rotator: sealed at 4 MB or after 1 h idle | below 4 MB |
| `buffer/sealed-<rfc3339>.jsonl` | daemon (renames `current`) | a sealed segment awaiting drain | drained to EOF, then unlinked | 0, occasionally 1 to 2 in flight |
| `feedback.db` | daemon | the SQLite store: events and signal tables | unbounded by design; `feedback purge` is the reset | grows with use (see Disk footprint) |
| `feedback.db-wal` | SQLite | the write-ahead log | auto-checkpoint at 1000 pages | roughly 4 MB, stable |
| `feedback.db-shm` | SQLite | the WAL shared-memory index | n/a | roughly 32 KB |
| `daemon.pid` | daemon | the daemon's process id | n/a | present with a live pid while the daemon runs |
| `daemon.log` (+ `.1` to `.3`) | daemon | the operational log | rolled at 1 MB, 3 copies kept | at most 4 files, 4 MB total |
| `capture-errors.log` (+ `.1` to `.3`) | capture hook | a record of capture failures | rolled at 1 MB, 3 copies kept | absent, or small and stale |
| `bridge/watermarks.json` | bridge | per-stream delivery cursors | atomic rewrite; near-constant size | small |
| `bridge.log` (+ `.1` to `.3`) | bridge | the operational log | rolled at 1 MB, 3 copies kept | at most 4 files, 4 MB total |

Three recent pieces of work shape this table. PR #17 gave the buffer daemon-owned size-and-age rotation. Issue #18 made the daemon own and size-bound both `daemon.log` and `capture-errors.log`, and cut `daemon.log` down to a readable record instead of a per-event firehose. `regimen-otlp-bridge` #10 did the same for the bridge: it now owns and bounds `bridge.log`, and folds per-tick deliveries into a periodic heartbeat so the file stays readable as well as bounded. The store's WAL behavior is settled in ADR-0005; the daemon and its health surface in ADR-0006.

## Health dimensions

Six dimensions. Each has a healthy reading, a degraded reading, and where the fact can be observed. The three the engineer asked for by name, how much space is used, how many files exist, and whether cleanup has happened, are dimensions 3, 4, and 5.

### 1. Liveness

Whether the moving parts that should be running are running.

- **Healthy:** the enabled flag is present; the daemon pid is present and the process is alive; if the bridge is installed, it is alive too.
- **Degraded:** the flag is present but the daemon pid is missing or stale (a pid that no process holds). ADR-0006 names this case explicitly: a dead daemon under a live flag is silent staleness, the worst failure mode, because capture keeps buffering while nothing drains. The bridge being dead is less severe (export stops, capture and the store are unaffected) but still worth surfacing.
- **Observe via:** the flag file's presence; `daemon.pid` plus a liveness probe on that pid; for the bridge, see Known gaps, it has no pid file today.

The daemon's **watcher mode** belongs here too. The daemon follows the buffer through a filesystem watcher that is sub-second on native backends (inotify, FSEvents) and falls back to slower polling elsewhere. On the fallback, freshness is bounded by the poll interval rather than the event. Status should name the mode so degraded freshness is explained rather than mysterious.

### 2. Freshness and flow

Whether data is actually moving through the pipeline, not just whether the processes are up. Freshness is the headline feature of the loader (ADR-0006): the store is meant to reflect what happened a moment ago.

- **Healthy:** the store's newest event tracks the buffer's newest line within a transaction's worth of latency; no sealed segments are piling up; the daemon's heartbeat is recent; the bridge's watermarks advance within seconds of new store rows.
- **Degraded:** the store lags the buffer by minutes; sealed segments accumulate (the daemon is behind or stuck); the heartbeat is stale; the bridge's watermark timestamps fall far behind the store's newest row (export is behind or failing).
- **Observe via:** newest `events.timestamp` in the store against the buffer's last line; the count of `sealed-*.jsonl` files; the most recent `heartbeat` line in `daemon.log`; the timestamps inside `bridge/watermarks.json` against the store's newest row.

A note on the last-event age: an old last event is *not* by itself unhealthy. A quiet machine with no agent sessions running simply produces no events. Age is informational. It becomes a health signal only paired with evidence that work *was* happening, so status should report it but not alarm on it alone.

### 3. Disk footprint (how much space)

The total bytes the data directory occupies, broken down by component, so the engineer can see what is consuming space and whether any of it is unexpected.

- **Healthy:** total footprint is the store plus a small, bounded remainder. Everything except the store has a hard ceiling: the buffer at roughly 4 MB, the WAL at roughly 4 MB, and `daemon.log`, `capture-errors.log`, and `bridge.log` each at 4 MB across their rolled copies. The bounded remainder therefore sits near 20 MB regardless of how long the daemon runs.
- **Degraded:** the WAL has grown far past 4 MB (checkpointing is starved); the buffer is stuck near or above its cap because drain is not keeping up.
- **Observe via:** a per-component byte breakdown, plus the directory total.

The **store** (`feedback.db`) grows with use and has no built-in ceiling. That is by design: it is the durable product of the instrument, not a log, and ADR-0005 keeps it small by storing structural events and signals only, never prompt or tool-output bodies. Its growth is managed, not a leak. Status should still report its size and event count so the engineer can decide when a `feedback purge` is warranted; there is no automatic store pruning, and that is a deliberate non-feature.

The **WAL** (`feedback.db-wal`) deserves a specific note because its size alarms people who do not know SQLite. Roughly 4 MB is the *healthy* steady state, not a problem. SQLite checkpoints the WAL into the main file automatically every 1000 pages and reuses the file in place rather than truncating it, so the file stabilizes near the checkpoint threshold and stays there. A WAL that is stable near 4 MB is the signature of checkpointing working. A WAL in the tens or hundreds of MB is the real signal: a long-lived reader is pinning the log and checkpoints cannot complete.

### 4. Accumulation and counts (how many files)

How many files of each kind exist. Several file types are expected to exist in small, bounded numbers; a count climbing out of that range is a health signal on its own, independent of total bytes.

- **Healthy:** zero sealed buffer segments in steady state, or one or two briefly in flight; at most three rolled copies each of `daemon.log` and `capture-errors.log`; a quarantine table at or near zero rows.
- **Degraded:** sealed segments accumulating (drain is behind, or the daemon is down and capture keeps sealing); a quarantine count that is nonzero and climbing (lines the loader could not translate, which means either malformed capture or a translator gap).
- **Observe via:** a directory listing of `buffer/`; the rolled-copy count for each log; `SELECT COUNT(*) FROM quarantine` in the store.

Rolled-copy counts are self-limiting by construction (the roller keeps three and discards the rest), so they cannot run away. Their value as a signal is the opposite: the *presence* of a `.1` copy confirms rolling has actually fired, which is dimension 5.

### 5. Boundedness and cleanup (whether it has been cleaned up)

Whether each growing file is in fact being kept in check, and whether the mechanisms that do that have actually run.

- **Healthy:** every file in the inventory that can grow is covered by a bounding mechanism that has demonstrably fired: the buffer rotates and sealed segments are drained then unlinked; the WAL checkpoints; `daemon.log`, `capture-errors.log`, and `bridge.log` each roll.
- **Degraded:** a file is growing and its mechanism has never fired or is failing; buffer rotation is persistently failing (the rotator reports `rename-failed-persistently`, possible on Windows when a hook holds the file); either logger reports nonzero `write_failures` in its heartbeat.
- **Observe via:** the last buffer rotation and the last log roll, visible in `daemon.log` (`rotated` lines and the `log-rolled` notice written into a freshly rolled file) and in `bridge.log` (the same `log-rolled` notice); the presence of rolled copies of each log; the `write_failures` field on either heartbeat line; the timestamp of the last `feedback purge` if one is recorded.

`feedback purge` is the manual cleanup lever. Plain `purge` discards the buffer; `purge --all` additionally drops the store, the WAL sidecars, and both operational logs with their rolled copies. It refuses to run while the daemon is alive unless forced, so a purge cannot race the daemon's writes. Status does not need to invoke purge, but surfacing total footprint is what tells the engineer when to reach for it.

### 6. Errors and integrity

Whether the pipeline is failing quietly anywhere.

- **Healthy:** `capture-errors.log` is absent or small and stale; the quarantine table is empty; the daemon logger reports no write failures; the bridge's recent log lines are deliveries, not failures.
- **Degraded:** `capture-errors.log` is present and recently written (capture is failing inside sessions, and capture failures are deliberately swallowed so they never surface to the session, which means this file is the *only* place they show); the quarantine count is rising; the bridge log shows repeated send failures.
- **Observe via:** the size and mtime of `capture-errors.log`; the quarantine count and newest `recorded_at`; a scan of recent `bridge.log` lines for `send failed`.

One bridge-specific failure deserves a name. Grafana Cloud rejects any single trace over 7.5 MB with `HTTP 422 TRACE_TOO_LARGE`. The bridge does not split, cap, or drop oversized traces; it retries the same batch forever, the watermark for that stream stops advancing, and `bridge.log` records the failure once at onset and carries a rising `traces_failed` count on every subsequent heartbeat. A frozen trace watermark plus climbing `traces_failed` is a specific, recognizable unhealthy state, not generic flakiness.

## What `feedback status` should surface

Today's status prints raw facts. An enriched status should do two things on top of that: lead with a single computed verdict so the common case is a one-line glance, and group the facts by the dimensions above so a degraded reading points at its own cause.

### The verdict

A top-line `healthy` / `N warnings` / `problem`, computed as the worst severity across the dimensions. Suggested mapping, with thresholds as starting points to tune against real readings:

- **Problem:** the enabled flag is present but no live daemon holds the pid; the store file is missing or unreadable; buffer rotation is failing persistently.
- **Warning:** sealed segments are piling up (more than ~5) while the daemon is alive; the quarantine count is nonzero and rising; `capture-errors.log` was written within the last hour; a bridge stream's watermark is more than ~30 minutes behind a fresh store; the WAL has grown past ~64 MB; either the daemon logger or the bridge logger reports nonzero write failures.
- **Healthy:** none of the above. Note that a stale last-event age on its own never lowers the verdict.

### Illustrative rendering, healthy

Values below are a real reading of the data directory on 2026-05-22.

```
Feedback health                                          [ healthy ]

  feedback     enabled
  daemon       running (pid 50053), watcher: inotify
  capture      last event 4s ago
  store        5,216 events, 23 conversations, 3.8 MB (+4.0 MB WAL)
  buffer       current 1.5 MB, 0 sealed, drain caught up
  daemon log   140 B + 1 rolled copy (272 KB), bounded 1 MB x3
  capture log  absent
  bridge       delivering, traces 45s behind, logs 6s behind
  bridge log   210 KB + 0 rolled copies, bounded 1 MB x3
  disk         12 MB total in ~/.local/share/regimen
```

### Illustrative rendering, degraded

```
Feedback health                                       [ 2 warnings ]

  feedback     enabled
  daemon       running (pid 50053), watcher: inotify
  capture      last event 9s ago
  store        812,440 events, 1,204 conversations, 240 MB (+58 MB WAL)
  buffer       current 0.3 MB, 7 sealed, drain BEHIND          (warning)
  daemon log   90 KB + 3 rolled copies, bounded 1 MB x3
  capture log  absent
  bridge       traces watermark frozen 3h, repeated 422s        (warning)
  bridge log   140 KB + 3 rolled copies, bounded 1 MB x3
  disk         305 MB total in ~/.local/share/regimen
```

The degraded example shows two things at once: drain falling behind (sealed segments piling up), and the bridge stuck on an oversized trace. Each is an actionable warning, called out on its own line above the breakdown.

### Per-line specification

| Line | Reports | Source | Lowers the verdict when |
|---|---|---|---|
| verdict | worst severity across all dimensions | computed | any problem or warning below |
| feedback | enabled or disabled | the flag file | never (disabled is a state, not a fault) |
| daemon | running with pid and uptime, or stopped, or stale pid; watcher mode | `daemon.pid` + liveness probe; `started` line in `daemon.log` | enabled but not running, or stale pid |
| capture | last event and its age | newest `events.timestamp` | never on age alone |
| store | event count, conversation count, file size, WAL size | the store; `feedback.db*` sizes | WAL grossly oversized |
| buffer | active segment size, sealed count, drain state | `buffer/` listing; store vs buffer newest | sealed segments piling up |
| daemon log | active size, rolled-copy count, the cap | `daemon.log*` sizes | logger write failures reported |
| capture log | absent, or size and recency | `capture-errors.log*` | present and recently written |
| bridge | delivering or behind; per-stream lag; 422 state | `bridge/watermarks.json`; recent `bridge.log` | a stream badly behind, or repeated 422s |
| bridge log | active size, rolled-copy count, the cap | `bridge.log*` sizes | logger write failures reported |
| disk | total directory footprint | the data directory | never directly; its components carry the verdict |

The bridge lines appear only when `bridge/watermarks.json` or `bridge.log` exists; on a machine without the optional bridge installed, they are omitted.

## Known gaps and recommendations

1. **`feedback status` is blind to the bridge process.** The bridge writes no pid file, so status cannot probe its liveness the way it probes the daemon's. Status can still report bridge *delivery* health from `watermarks.json` and `bridge.log`, both of which live in the shared data directory, but it cannot distinguish "bridge stopped" from "bridge running but stalled." Recommendation: have the bridge write a `bridge.pid`, symmetric with `daemon.pid`. Failing that, status should infer liveness from watermark and log recency and label it explicitly as an inference.
2. **The store has no automatic pruning.** This is deliberate, the store is the product, but it means footprint grows for the life of the install. The only lever is `feedback purge`. Status should make the store's size and growth legible enough that the engineer reaches for that lever before disk pressure forces it.
3. **Capture health is only weakly observable.** Capture failures are swallowed by design so they never break a session, which means `capture-errors.log` is the single place they appear. Status should treat that file's presence and recency as the real capture-health signal, and should not try to infer capture health from event age, which conflates a broken hook with an idle machine.
4. **There is no health verdict today.** Status currently prints facts and leaves interpretation to the reader. The single biggest improvement is the computed top-line verdict, so that the answer to "is Feedback healthy" is the first thing on screen and the breakdown is there only when it is not.

## Related

- [`feedback-surfacing.md`](feedback-surfacing.md): what Feedback surfaces about the engineer's AI work, the other, product-facing meaning of "what Feedback shows."
- [`adr/0005-feedback-data-architecture.md`](adr/0005-feedback-data-architecture.md): the buffer, the store, and why conversation content is deliberately absent.
- [`adr/0006-feedback-loader-architecture.md`](adr/0006-feedback-loader-architecture.md): the always-on daemon, freshness, buffer rotation, and the health surface.
