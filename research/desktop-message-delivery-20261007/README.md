# Background work and user input, October 7

## Reproduced defect

The user's existing ordinary Namzu conversation launched a child and waited for
its result. The Desktop accepted follow-up messages into its next-turn queue.
The assistant subsequently attributed the missing input to the user. The later
[read-only native observation](artifacts/existing-namzu-chat-observation.json)
records the still-active parent, one remaining queued message and completed tool
receipts. The user's earlier screenshot shows three queued messages. These are
different observation points, rather than conflicting counts.

Full conversation contents stay in a private native receipt. The committed
receipt contains ownership digests, counts, public controls and classifications.
The observation made no model request, edited no queue and cancelled no work.

## Existing mechanisms

The CLI's actual delegated-agent runtime already releases `wait_for_task` when
operator input arrives. Its TUI supplies `inboundMessages` and `waitForInbound` to
the active query. The Desktop's ACP gateway did not supply those callbacks, and
the Desktop main process put every busy submission into the next-turn queue.
Sending a second concurrent ACP `session/prompt` is not a substitute: the server
correctly refuses a second in-flight prompt in the same session.

The current fix connects an explicitly negotiated, scoped text inbox to that
existing query mechanism. It distinguishes acceptance from consumption, keeps
explicit next-turn queueing, and preserves undelivered text on settlement. It
does not turn operator input into cancellation of the parent or child. An old
runtime or an unsupported conversation keeps truthful queue behavior.

## Primary source comparison

- [Codex App Server](https://learn.chatgpt.com/docs/app-server), read October 7:
  `turn/steer` admits input into an existing turn and requires its exact
  `expectedTurnId`. It does not create a new turn or accept turn-level model and
  workspace overrides. Namzu's current native Codex adapter exposes start and
  interrupt, and has not yet exposed that operation.
- [OpenAI's Remote engineering workflow](https://developers.openai.com/blog/mastering-codex-remote-for-engineering),
  read October 7: queueing schedules the next turn; steering redirects work in
  progress. They are separate user actions.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
  read October 7: persistent input supports multiple queued messages and
  interruption. This documents sequential input; it does not by itself establish
  the same wait-release behavior as Namzu's delegated runtime or Codex steering.

Real engine comparisons use isolated native Desktop profiles, offered inexpensive
models and a bounded read-only background-child task. A reported shell process or
an assistant's claim alone does not prove a native background child. Native
receipts must establish the overlap before interpreting the second submission.

The [native comparison receipt](artifacts/native-engine-comparison.json) records
three actual UI submissions and three native prompts, with no automatic approval
or action in the primary app. The installed baseline routes to real Claude Haiku
and Codex `gpt-5.6-luna`:

- Claude launched one Haiku background Agent, then ended its parent turn. A later
  second message received its acknowledgement. This proves delivery after the
  parent had ended, **not** delivery during an overlapping wait. The native child
  requested a foreground PowerShell sleep which was refused, then received a
  background shell launch receipt. Neither that receipt nor the absence of final
  rows proves the sleep or child completed. The [bounded child metadata
  audit](artifacts/claude-owned-child-metadata-v3.json) contains no reasoning or
  message bodies.
- Codex answered that the native background primitive was unavailable and made
  no tool call. This is a model report, not an authoritative tool-catalogue
  result. A separate [read-only installed feature
  probe](artifacts/codex-installed-feature-metadata.json) reports Codex CLI
  `0.154.0` with `multi_agent` enabled. The comparison therefore remains
  incomplete; no expensive model fallback or invented child fills that gap.

The [Open Dot source audit](open-dot-review.md) pins its current commit and
compares implementations, rather than assuming Namzu lacks equivalent features.
Open Dot also queues messages until its active run finishes. Its file-delivery
and unread-result presentation are useful follow-up ideas; its inbox does not
supply the current-turn wait-release mechanism required here.

## Verification

The deterministic CLI test runs the actual query loop and delegated runtime with
controlled providers: new operator input releases the wait, appears after the
required tool result, leaves the original child alive, and later receives its
completion once. Exact-scope, terminal, idempotency, abort and mailbox limits are
covered separately. Desktop subprocess tests cover retained unknown admission,
pending-input cancellation, explicit queueing and unsupported-runtime fallback.

The [isolated React browser proof](artifacts/live-input-renderer-browser-proof.json)
uses the real renderer with a synthetic API and makes **zero** model/native
requests. It checks current-turn Send, admission versus delivery, explicit Queue,
and the old-runtime path in a short viewport with reduced motion. It is not a
real-provider delivery claim.

The [source verification receipt](artifacts/source-verification.json) records
the completed typecheck, lint, workspace tests, CLI/Desktop builds and docs gate.
The workspace run passed 20,063 tests with 116 skipped. A later final Desktop
run passed all 808 tests across 87 files, including the last transcript-order
regressions; the earlier workspace run's Desktop count is retained separately.

Primary-app activation is separate from source/build verification. After
cancellation the user conversation retained two queued authored messages. Their
exact IDs, text and permission modes were saved privately before asking the user.
The user explicitly approved preserving that backup, removing those two queue
entries and reopening the updated app. The [queue-removal
receipt](artifacts/user-approved-queue-clear-v2.json) confirms a fresh exact match,
two removals, unchanged 23-message history, draft and settings, and zero automatic
replay/model requests. The original backup remains private and byte exact. The
activation helper retains its existing active-work/queued-input refusal.

### Native activation and continued activity

The [Windows activation](artifacts/live-input-native-activation.json) closed the
old primary, retained its Desktop build backup, applied the complete built
Desktop and exactly three reviewed CLI modules, and opened a fresh primary. A
later read-only payload check verified all applied bytes, unchanged SDK and
unrelated CLI files, and the same 225 dependency links and 11 SDK consumers.
Neither activation nor inspection requested a model turn or computer action.

The original startup guard remains **failed**: the captured editor/draft equality
check failed while conversation activity continued. A later strict snapshot
comparison also failed because tabs had been added and reordered. Those results
and full snapshots remain private and immutable; the guards were not weakened
or relabelled as successful.

The [offline reconciliation](artifacts/live-input-captured-snapshot-reconciliation.json)
verifies all 23 original target message bodies as an exact prefix, its draft,
settings, files and work, and four other unchanged original conversations,
including a separate unsent draft. Codex's old draft became exactly its first
user message, followed by two assistant messages. All original tabs remain
present among the ten observed tabs; current focus and the current editor were
preserved. One additional target assistant message surfaced after restore. This
snapshot does not establish its origin, model generation or child completion.
It is not either queued backup prompt. No automatic replay was requested.

The [native diagnostics metadata](artifacts/live-input-native-diagnostics.json)
contains zero error-severity rows for the inspected interval. Its six notices
report the explicitly stopped Podman machine during read-only computer status
checks. The captured renderer has no visible dialogs or alerts and exposes the
new `sendCurrent` preload API. These are bounded integrity and UI checks, not a
claim that every state remained unchanged while the application was in use.

## Isolated comparison cleanup

The comparison used our separate test profile, rather than the user's primary
profile or Pal computer. The [preflight](artifacts/owned-test-cleanup-preflight.json)
passed, but closing its diagnostic server and window initially
[failed](artifacts/owned-test-first-normal-close-failed.json) to establish process
exit. That unsuccessful result remains recorded;
the unfinished child was not declared completed. The exact finished diagnostic
controllers were then retired after checking process creation times, source
paths, private receipts and ownership. This deliberately retires our test and
may terminate its Windows child job; it is not a graceful-child-completion claim.
The first controller-retirement attempts made no action after failed validation.

After the clients detached, a second normal window-close request was accepted.
The [final read-only observation](artifacts/owned-test-retirement-observation-v3.json)
confirms the isolated fixture exited and the primary remained alive. No user
queue, model, primary process or computer action was involved in that cleanup.
The separate approved queue removal above is the only authored-input action.
