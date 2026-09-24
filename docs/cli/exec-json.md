---
type: Reference
title: namzu exec --json
description: The headless one-shot as a stream for host UIs — one NDJSON event per line on stdout, the session and turn ids it reports, how --session binds history, the one-active-turn refusal, and what each exit code means.
resource: packages/cli/src/commands/exec-json.ts
tags: [cli, headless, streaming, ndjson, sessions]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# `namzu exec --json`

`namzu exec --json` runs one prompt as one turn, exactly as `namzu exec` does,
but instead of printing the final text it writes one JSON object per line to
stdout as the turn unfolds. A host process — a desktop app embedding namzu, an
editor extension — line-scans stdout and renders the turn live. Earlier
releases called this command `namzu run-stream`; the events and their fields
are unchanged.

```bash
namzu exec --json --session my-window-7 "refactor the parser" \
  | jq -c 'select(.kind == "tool-start" or .kind == "done")'
```

It takes the same options as the default mode (`--provider`, `--model`,
`--effort`, `--permission-mode`, `--cwd`, `--skills`, `--gate`, `--trust`,
`--output-schema`, the limit flags and the `[permissions]` config table),
except `--continue`, `--resume` and `--wait-for-provider`, which are refused by
name rather than ignored. With `--output-schema <file>` the settled answer in
`done.text` is JSON bound to that schema; a schema that cannot be loaded is an
`error` event and exit 0, because the caller can fix it. See
[Exit codes of `namzu exec`](exec-exit-codes.md#a-structured-answer---output-schema).

## The stream

Every stdout line is one JSON object with a `kind`. Logs go to stderr as
NDJSON, so stdout stays a clean protocol stream.

| `kind` | When |
|---|---|
| `delta` | Assistant text as it streams. Earlier deltas may include progress, or an answer later rejected by verification. |
| `reasoning` | A reasoning block, when the model exposes one. |
| `tool-start`, `tool-progress`, `tool-end` | Around each tool call, keyed by `toolUseId`. |
| `usage` | Token and cost totals, and the budget snapshot. Carries `sessionId` and `turnId`. |
| `task`, `job`, `context` | Task-list changes, background jobs, and compaction. |
| `provider-fallback`, `capability-warning`, `history-repair` | Notices about how the request was served. |
| `notice` | Something the host should show but that is not a failure: a config notice, or a turn that ran but could not be saved. |
| `paused` | The turn parked with a checkpoint (a provider wait or a decision): `turnId`, `checkpointId`, `reason`, and any retry guidance. |
| `error` | A failure, in band. A refusal to start a turn in a busy session has `code: "turn_in_progress"` and names the active turn. An invocation stopped by SIGTERM, SIGHUP or SIGINT writes one with `code: "terminated"` just before its last `done` (see below). |
| `done` | Always last. `text` is the settled answer — use it, not the concatenated deltas. Carries `sessionId`, `turnId` and `stopReason`. |

## History: `--session`

With `--session <key>`, the turn is bound to a persisted conversation in the
working directory's project. The key is the host's own id for the
conversation — any string — and is recorded as an external reference of the
session, so the same key finds the same session on the next call and survives
an index rebuild. Prior turns are the session's context, and the settled turn
is appended to the session log, where `namzu history --session <key>` reads it
back.

Without `--session`, prior history may be supplied on stdin as one JSON
`Message[]`, and nothing is persisted: the call is a stateless one-shot.
Invalid or provider-incomplete tool history is refused before a turn starts.
A message may carry `id` (`BaseMessage.id`, the durable record it came from —
see [Session log](../sdk/session-log.md#a-hosts-cached-messages)); it is
accepted and kept, never stripped or required. This stream's own events do
not yet surface a message's `id` as it happens — a host rebuilding
`Message[]` purely from this stream's `delta`/`tool-start`/`tool-end` events
has none to attach — but a host that instead reads a prior turn back from
`namzu history --session <key>` gets the real id on every message, and can
feed that history into a later stateless call unmodified.

**One turn at a time.** A session has at most one active turn. A call against
a session whose last turn is still running, or is paused, does not start a
second one: it writes an `error` event with `code: "turn_in_progress"` naming
that turn, then `done`, and exits 75. Resume or abandon the active turn (in the
TUI, `/resume` or `/abandon`), or use another session.

## Exit codes

Every failure is reported in band first. The exit code then says whether the
caller can reach the turn it asked for by changing what it sends.

| Code | Meaning |
|---|---|
| 0 | A turn started (whatever its outcome — render it), or the caller can fix the request: an unknown option, no prompt, a bad `--cwd`, an unknown permission mode or provider. |
| 1 | Nothing the caller sends changes it: no provider available, a missing credential or driver, a declared tool server that is not there, a conversation that cannot be opened, a command file that will not parse. |
| 75 | The session already has an active turn. Try again later, or resume or abandon that turn first. |
| 77 | The folder has not been trusted; only a person can change that. |
| killed by the signal | Stopped by SIGTERM, SIGHUP or SIGINT. The last two lines are `{"kind":"error","code":"terminated",…}` and the stream's only `done` (when stdout is still there to write to); no event after those two is written. The session's lease was given back first. Mid-turn, the `done` is `{"kind":"done","sessionId":…}` and the turn is left interrupted, so `/abandon`, `/resume` or `namzu drain` takes it at once. After the turn settled, while the session is still closing (a slow `session_end` hook, say), the error's message says the turn ended and is recorded, and the `done` is the turn's own, with its `turnId`, `text` and `stopReason`. |

The default mode of `namzu exec` shares 1, 75 and 77 with the same meanings;
see [Exit codes of `namzu exec`](exec-exit-codes.md).
