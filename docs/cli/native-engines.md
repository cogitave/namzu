---
type: Reference
title: Native conversation engines
description: How the desktop ACP host composes installed native conversation engines, their model catalogues, durable ownership, review callbacks and process shutdown.
resource: packages/cli/src/integrations/harness/claude-adapter.ts
tags: [cli, desktop, engines, sessions, permissions]
status: stable
---

# Native conversation engines

The ordinary desktop conversation host can select Namzu, an installed Codex
CLI, or the installed `claude-code` engine before starting a conversation. These
are separate execution routes. Selecting Namzu's `codex` or `anthropic` model
provider continues to run Namzu's kernel with borrowed credentials; it does
not start an external engine.

The ACP extensions `namzu/harnesses/list` and `namzu/harnesses/select` report
and select the engine for an owned conversation. Selection requires the exact
trusted ordinary project. A conversation that has started retains its engine;
open a new conversation to use a different one. Pal conversations retain their
guest admission and do not use native host engines.

Native execution is composed through the [SDK harness session](../sdk/harness-sessions.md).
The host keeps its own session identity, original journal and writer lease.
Native session/thread IDs are opaque and separately bound to the engine,
profile route and exact canonical execution directory. They are never used as
Namzu conversation IDs or resolved through a generic external-session alias.

## Installation, models and authentication

The resolver selects a real native executable or a known installed native
package entry. Windows `.cmd`, PowerShell and shell shims are not interpreted.
The transport uses exact argv with `shell: false`, an admitted cwd and a
captured environment. There is no installation or sign-in flow during engine
selection.

Each engine supplies its own model catalogue. The `claude` adapter initializes
the installed persistent `stream-json` protocol and asks `list_models`.
Metadata discovery closes its owned process without sending a user prompt,
uses no session persistence and disables hooks/MCP for that isolated probe.
It has no bundled/version-derived model fallback. Model metadata and local
sign-in status establish availability of that interface; neither establishes
that a fresh inference request is authorized. Native startup may itself
refresh or change its own authentication state.

Model rows keep the engine's own ids. Codex labels read as its app shows them (`GPT-5.6-Sol` becomes `GPT-5.6 Sol`), and the row the engine recommends carries an optional `default: true`: Codex's `isDefault` row, or for the second external engine the row its non-selectable `default` entry resolves to.

A real native turn can refuse expired or missing credentials even when its
local catalogue is available. Authentication failures use a fixed notice.
Remote error assistants, error bodies, stderr, token material, account details
and thinking replay/signatures do not become public journal output.

## Codex session behavior

A native terminal receipt retains the actual completed final-answer item identity
from its own turn. The final result is derived from that completed message,
so a terminal notification without text does not erase a streamed reply.
History reconciliation reconstructs the same identity; commentary and
unfinished or foreign-turn messages cannot become a settled final answer.

Codex runs its installed `app-server` JSON protocol as an owned persistent
process. Initialization and model discovery use that engine's protocol;
creating or reopening a conversation binds the exact native thread, profile
route, canonical execution directory and confirmed initial model. The real
catalogue default is ordered first. Namzu does not reuse its `codex` provider
model list for these sessions.

Each Codex turn sends the selected model's current native default reasoning
effort when no explicit effort is selected. Codex keeps turn overrides on its
thread, so omitting that value would retain an earlier selection after choosing
Default effort or changing models. If the native catalogue does not report a
valid default, dispatch requires an explicitly offered effort; Namzu does not
guess one.

Before SDK turn admission, the connection reports the effort levels discovered
from the native model catalogue. Each dispatch then checks the selected effort
against a fresh row for the selected model. A level offered by another model
does not authorize that choice, and Namzu adds no guessed effort levels.

The adapter subscribes before initialization and dispatch. Native turn/item
IDs map to stable host message and observed tool identities. Final snapshots
replace partial output; a terminal notification arriving before dispatch ACK
cannot restart the finished turn. Public reasoning summaries are separate
from assistant text; private replay material is omitted.

Native command and file reviews retain the original numeric or string RPC
request ID, exact thread/turn and immutable proposal. The desktop offers
Ask first, confirmed Full access and Plan. The ACP host admits Codex's declared
review modes, including retained explicit Allow edits and Preapproved only
policies; `claude-code` still admits only Ask first and Plan. Codex Full access
uses the native danger-full-access sandbox with on-request approvals, rather
than Namzu tool rules. Ask first retains the adapter's conservative untrusted
approval/read-only mapping. A turn interrupt ACK does not
establish completion: the matching terminal event or confirmed owned process
stop is required. Codex history reconciliation pages the exact native thread;
incomplete or conflicting evidence prevents automatic prompt replay.

## Stream-json session behavior

New sessions use an independently minted native `--session-id`; reopen uses
the exact bound `--resume` ID and execution directory. The persistent process
uses streaming input/output, partial messages and permission callbacks over
stdio. It inherits the engine's normal project/user settings and tool policy.
The engine owns its tools and plugins; Namzu's tool executor, plugin manager
and remembered grants do not admit those native operations.

The adapter supports Ask first (`default`) and Plan (`plan`). Model and mode
control responses must settle before a prompt is sent. An unknown control
outcome refuses later dispatch until the connection is closed. Plan does not
allow `ExitPlanMode` approval to silently execute the plan. Native questions
whose typed answer interface is not supported receive “Answer this question
in the conversation” denial feedback. Attachments are not offered by this
initial adapter.

Reasoning effort follows the engine's own catalogue. A model row that reports
effort support carries the levels Namzu knows (`low` to `max`); a row without
support carries none, and Namzu adds no guessed levels. The engine fixes effort
at launch, so a turn that asks for a different level than the running process
was launched with restarts the process on the same native session (resuming it
once a turn has been sent) with `--effort <level>`, and only while the engine is
idle between turns; a turn never restarts mid-work. No selected effort launches
without the flag and so uses the engine default. A level the selected model does
not offer is refused before anything is restarted or sent.

An incoming `can_use_tool` request captures its exact native session, operation,
request ID, tool-use ID and immutable proposed input. Approval applies once to
that live request. Foreign, changed, cancelled, already answered and uncertain
requests are refused; writing a response does not establish tool completion.
Actual native tool-result frames supply observed tool receipts.

The stream-json interface exposes no native turn ID. The adapter reports
`turnIdSource: 'operation'` and uses the SDK's captured operation ID for its
serialized turn correlation. Native message IDs preserve streamed and full
snapshot identity. Full messages replace partial text; two messages with the
same text keep separate identities. Public thinking text can be shown, while
signature and redacted replay blocks are omitted.

The engine vendor's [documented streaming flow](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow)
emits each completed content block as a separate assistant frame sharing the
same native message ID. The adapter merges those blocks using their stream
indices and native block UUIDs. It completes a streamed message at
`message_stop`, with its actual message-level stop reason. UUID-bearing block
receipts remain separate even when partial events are absent and every block
repeats the stop reason; the terminal result then closes remaining messages.
Without partial events, a distinct next native message also confirms completion
of an earlier block group that already reported an explicit stop reason.
Legacy UUID-less explicit full snapshots retain their completion boundary.
An earlier thinking or text block cannot discard a
later observed tool call. The completed tool block supplies its authoritative
input; partial input chunks and permission callbacks do not establish execution.
Matching tool-result frames settle that receipt once. Duplicate blocks and
completed or older-operation replays cannot create another tool receipt.

When a failed or interrupted result closes an unfinished streamed message,
the message lifecycle uses `stopReason: 'cancelled'` and retains its partial
text. A failed turn still reports `status: 'failed'` with its existing error;
this message marker does not report a user cancellation. Earlier messages
already completed by the engine retain their original stop reason.

A successful result-only frame uses its actual native result UUID as the
message identity, so final text is retained in the original journal even when
the engine emits no assistant message frame.

An interrupt control ACK means the request was delivered. Completion still
requires the matching native terminal result or confirmed owned process stop.
Known old items/results cannot settle a later operation. Native background
tasks and reported running state prevent the next prompt from being assigned
to unfinished prior work.

## Recovery and shutdown

The SDK records prepared/accepted dispatch and exact native review receipts.
An uncertain send is retained for reconciliation and is never automatically
replayed. The stream-json adapter has no authoritative history query:
`history: 'unavailable'` and `readHistory().complete: false` report that limit.
Settled original Namzu journal history remains available. Restart can resume
an exact settled binding; ambiguous active work cannot be reconstructed from
an incomplete metadata snapshot.

Closure first sends stdin EOF, then bounds the grace period before stopping
the owned process tree. Success requires confirmed closure; failure retains
the handle for retry. A control request, root process exit or a stop-command
ACK alone is not a successful shutdown receipt.

## Verification boundary

Deterministic adapter tests use an injected native protocol transport to prove
message identity, exact reviews, ordering, aborts, unknown outcomes and cleanup.
An integration fixture runs that adapter through the real SDK session and
original journal, checking native review resolution, observed tool receipts
and result-only message identity. The fixture performs no inference.
Native Windows metadata was separately checked with the installed `claude`
executable, version 2.1.278:
initialize and `list_models` returned five installed-engine rows and EOF closed
the owned process with exit zero. That metadata probe sent no user prompt and
does not prove successful inference or account authentication.

The October 4 native Windows desktop check additionally ran a real `codex-cli`
prompt, reopened its settled journal, continued the same native thread, and
approved one printing-only Windows command through the desktop's Allow once
control. Separate tab drafts and engine-owned model catalogues were verified
in that production application. The installed `claude-code` route returned its
real catalogue; its attempted prompt failed with the current local sign-in and
displayed the authentication notice while retaining its engine binding. That
device's successful native inference proof is for `codex-cli` only.
