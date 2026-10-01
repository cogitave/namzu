# Native child continuation and output readiness verification

Date: 2026-10-01. Baseline: `7f5f1284` on
`feat/runtime-desktop-foundation`; these receipts describe the subsequent
implementation, not the earlier research-only tree or a published package.

## What actually ran

The real built Namzu CLI ran in a Linux/WSL PTY at 120 columns × 38 rows.
The SDK query, child manager, session logging, host review, background process
registry and real Node shell processes were used. Provider transport alone was
scripted; these experiments make no claim about model account compatibility.
Each run allocated a new temporary home and project. No live user conversation,
job, preference or credential file was changed. ANSI was interpreted by the
installed headless terminal. Native I/O has a failure bound; tool releases are
explicit files, not machine-speed assertions in unit tests.

Reproduce after the workspace build:

```sh
python3 research/agent-messaging-20261001/namzu-child-native.py
python3 research/agent-messaging-20261001/namzu-readiness-native.py
```

The drivers print their owned scratch directories. Raw model requests, session
logs and process evidence remain there. Committed frames replace that path with
`<owned-native-root>`, trim trailing whitespace and empty terminal rows, and
contain only scripted prompts/output. The full 38-row frames remain in scratch. The derived
[receipt](artifacts/native-continuation-readiness.json) was checked against
accepted journal rows, child metadata, provider requests and clean driver exits.

## Child conversation

1. Start a child with a real held shell call. Keep an unsent parent draft.
2. Open the child's transcript and send a direct operator correction. The
   receipt says queued; the tool remains in flight.
3. Release the tool. The next child request contains its tool result before the
   correction, and the parent receives the changed assignment and result.
4. Send another instruction to the finished child. Native journal records show
   a distinct TaskId in the same child conversation, with a fresh provider.
   Its request retains the original instruction and previous answer.
5. Correct that follow-up while its second real shell call is held. Release it.
   The follow-up finishes with the correction, while the old task stays terminal.
6. Return to the parent: its unsent draft survives. A later parent request sees
   the host assignment record and explicitly framed child result.
7. Exit normally. The driver and owned host close cleanly.

Selected frames: [busy correction](artifacts/child-child-busy-queued.txt),
[fresh invocation](artifacts/child-child-followup-started.txt),
[preserved parent draft](artifacts/child-parent-draft-preserved.txt),
[parent result context](artifacts/child-parent-followup-notice.txt).

Deterministic regressions separately verify stale ownership, current review and
budget scopes, summary immutability, owner-version takeover, failed admission,
consumer lifetime cancellation and truthful execution outcomes.

## Persistent process readiness

1. Launch an owned HTTP server on an ephemeral loopback port. It prints `READY_`
   and holds the remaining bytes behind an explicit file release.
2. Call `wait_for_job` with literal `READY_719` on stdout. The TUI shows the live
   wait before the marker is complete.
3. Release `719`. One condition result reports the stdout match; the server is
   still running. A subsequent real shell command fetches its HTTP endpoint and
   verifies the response. Output observation did not imply HTTP health.
4. The parent turn ends with the persistent job still visible in `/jobs`.
5. Exit Namzu and verify the exact owned server process is gone.

Frames: [live wait](artifacts/readiness-waiting-for-output.txt),
[finished turn with running server](artifacts/readiness-readiness-completed-server-running.txt),
[job visibility](artifacts/readiness-persistent-server-visible.txt).

The first readiness probe exposed a pre-existing query defect: starts and
progress were recorded but drained only after the tool batch completed. Its
120-second wait timed out while the driver waited for the missing live row.
After the event-driven stream correction, the same probe passed. Closing a
consumer during the new live yield also cancels and joins executor settlement;
an actual-query regression verifies receipts precede resource release.

## Limits

These are Linux/WSL native terminal checks, not native Windows/macOS installer
tests. Saved child logs remain observation rather than execution authority.
Isolated-workspace continuation remains refused until a lease contract exists.
One-shot readiness is not a recurring watcher or automatic model wakeup.
Pal deployments, durable dependency workflows and external A2A conformance
remain separate product work listed in `IMPLEMENTATION-PLAN.md`.
