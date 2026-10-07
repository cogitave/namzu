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

Primary-app activation is separate from source/build verification. The observed
user conversation retains two queued authored messages after cancellation. The
activation helper preserves the existing active-work/queued-input refusal; it
does not discard or automatically replay those messages to permit a restart.
