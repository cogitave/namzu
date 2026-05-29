---
'@namzu/cli': minor
---

run-stream gains `--session <key>` and a new `history --session <key>` command:
bind a headless turn to a persisted conversation in the cwd's `.namzu` store
(keyed by an embedder's own session id), so prior turns load as context and
the turn is appended. `history` prints that conversation's `{role,content}[]`
as JSON. This lets a host UI (the clawtool desktop) resume a session's
transcript and keep multi-turn context across separate one-shot invocations.
