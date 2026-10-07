---
type: Reference
title: Agent client protocol
description: Stdio prompt, permission, cancellation and durable-history boundaries for editor and desktop clients.
resource: packages/sdk/src/bridge/acp/server.ts
tags: [sdk, protocol, sessions, hosts]
---

# Agent client protocol

`ACPServer` adapts an `AcpAgentGateway` over an `MCPTransport`. Initialize with
`capabilities: ['permission']` before creating/loading a session. The peer must
answer `session/request_permission`; the bridge does not assume a missing human
approved a tool. `session/new`, `session/load`, `session/prompt` and
`session/cancel` preserve session ownership. Updates arrive as `session/update`.
Completed tool updates retain the runtime-provided result presentation, including
bounded diff and terminal views. Older event producers without a presentation
keep the text-based presenter fallback. Clients do not infer changes from tool
arguments or names.

Tool progress uses the existing `tool_call` update with optional `progress`
(`message` and an optional completion fraction). A client preserves the prior
presentation while updating progress. `turn_ended` may carry the actual `error`
message; a host should display that explanation instead of inventing a cause.

## Streamed reasoning and message lifecycle

`AcpSessionUpdate` is a closed exported union. Clients upgrading from the earlier
chunk-only stream must handle two additional variants: `agent_thought` and
`agent_message`. Existing kinds and their required fields remain available.

| Update | Meaning |
| --- | --- |
| `agent_thought` | A reasoning block started (`status: 'pending'`) or ended (`status: 'completed'`). |
| `agent_thought_chunk` | A fragment of readable reasoning supplied by the provider. |
| `agent_message_chunk` | A public assistant text fragment. |
| `agent_message` | The message completed; `content` is its settled text and `stopReason` is the message's own finish reason. |
| `turn_ended` | The prompt segment settled or parked; its exact `reason` supplements the coarse `stopReason`. |

Reasoning updates optionally carry the actual `messageId`, `turnId`, `iteration`
and `blockId`. The block identity combines the message ID with the reasoning
block index. Retain each block at its admitted transcript position rather than
joining all reasoning into one turn-wide string. A redacted block still has
start/end boundaries, but the bridge never exposes its opaque payload, signature
or encrypted replay material. Completion boundaries contain no reasoning text;
readable text arrives only through `agent_thought_chunk`.

Message chunks optionally carry `messageId`, `turnId`, `iteration` and the
provider's public `textPart` identity. `phase` mirrors an explicitly supplied
`commentary` or `final_answer` phase; it is absent when the provider names none.
Completed messages optionally retain their ordered public `textParts` and their
selected `content`. The selected content excludes intermediate commentary when
the provider supplied explicit final-answer parts. Use the actual identity to
settle that message; a tool row between chunks must not redirect its completion.
These message boundaries do not mean the whole turn finished. The runtime
keeps the same message ID in streamed deltas, the completed message, its durable
`message` record and the final `turn_ended.messageId` that selects that answer.
This also applies to a forced closing summary. Distinct model messages retain
distinct IDs even when their text is identical; clients reconcile by identity,
not by matching answer text.

`turn_ended.result`, when present, is the authoritative answer after guardrail,
review and structured-output corrections. Replace the preview rather than
appending this result as another answer. An empty string is a real correction
that clears blocked output; absence means the producer did not supply a settled
answer. Optional `messageId` names the runtime's recorded answer message, and
`turnId` identifies its turn. Completed tool calls may carry their measured
`durationMs`, including zero; do not derive execution duration from UI updates.

The coarse `AcpStopReason` vocabulary remains `end_turn`, `cancelled`, `refused`,
`error` and `max_turns`. Input/output guardrails and step/review refusal map to
`refused`; iteration/token/cost limits map to `max_turns`. Timeout, unmeasurable
cost and failed structured output map to `error`. Legacy aliases remain accepted.
Optional `reason` preserves the exact runtime cause so a client can describe a
cost limit or output guardrail accurately instead of treating the coarse label
as a complete diagnosis. `reason: 'paused'` describes a checkpointed segment,
whose coarse label is `cancelled` for older clients; it does not claim the active
turn was cancelled.

A paused segment carrying a classified failure also supplies the existing
`turn_ended.error` field with its recorded failure message (or pause reason when
only the provider classification is available). Display that explanation even
when `stopReason` is `cancelled`; the checkpoint is retained, and the failure
is not a user cancellation. Ordinary review/handoff pauses and user cancellation
do not manufacture an error. The bridge does not expose the complete provider
payload or change the prompt response's coarse pause category.

`AcpSessionPromptResult` also carries optional `reason`. If cancellation occurs
during preparation, before any runtime event, the response contains
`stopReason: 'cancelled'` and `reason: 'cancelled'` without manufacturing an answer
or a runtime event. A client should use this response as a terminal fallback
when no `turn_ended` update arrived. The server preserves mapped update order
and finishes sending those updates before returning the prompt response.
Permission questions wait for updates already admitted at the time of the ask.
An update-delivery failure prevents that review from being sent or assumed
approved. Delivery errors are caught immediately, retain the first failure and
release the prompt's in-flight slot after the queue settles. A failed question
send also settles its wait instead of leaving consent pending forever. A delivery
failure does not undo work that already ran; durable session history remains the
source for what the runtime actually completed.

Provider-hosted web search and fetch activity uses existing `tool_call` updates,
with `provider-hosted-web-search:`-qualified IDs and the provider's pending/completed/failed state.
Only reported query/URL and result count enter the bounded display caption. This
is a provider execution receipt; it does not request local execution or approval.
Retry, fallback and compaction events remain outside this update vocabulary. No
raw session event, system prompt or discarded compaction body is forwarded as a
generic payload.

## Negotiated planning notifications

An embedding host can set `AcpServerOptions.supportsTaskNotifications: true`
to advertise the optional `ACP_TASK_CAPABILITY` (`namzu/tasks`). Only clients
that also declare that capability receive the separate
`ACP_CLIENT_NOTIFICATIONS.TASK_UPDATE` (`namzu/tasks/update`) notification.
The closed `AcpSessionUpdate` union and core `session/update` vocabulary remain
unchanged, and hosts that omit this option retain their earlier wire behavior.

The exported `AcpTaskUpdate` payload is `{ sessionId, task: AcpTask, deleted? }`.
`AcpTask` contains the existing planning `taskId`, `subject`, `status`, an explicit
`blockedBy` array, and optional `owner`. Each notification replaces the entire
row: an empty dependency array clears earlier blockers and an absent owner
clears an earlier owner. `deleted: true` removes the row. `status` retains the
existing `TaskStatus`, including `failed`; failure is distinct from completion.
These notifications describe agent-maintained planning items, not delegated
worker invocations or proof that work succeeded.

The bridge projects only `task_created` and `task_updated` events whose
`sessionId` matches the addressed prompt or retry. Child and foreign-session
tasks are omitted. It sends no descriptions, metadata, tenant identifiers,
filesystem paths or raw event payloads. Notifications share the prompt's existing
ordered delivery queue with core updates: admitted deliveries settle before
permission requests and the prompt response. A failed delivery prevents a later
review from being sent or assumed approved. This stream does not reconstruct
tasks on session load; the host must provide a scoped snapshot for cold restore,
such as the CLI's explicitly installed `namzu/tasks/list` extension.

The gateway loads durable history, not a transport-owned transcript. Its
`load(sessionId, cwd?)` receives the requested absolute workspace as the second
argument. Existing one-argument gateways remain valid; hosts with scoped stores
should use that workspace to check project and tenant ownership. The CLI gateway
uses its existing resumable-conversation check and rejects archived writers.

## Prompt attachments and options

`AcpSessionPromptParams.attachments` optionally carries inline user image or
document attachments. An embedded host opts in with
`AcpServerOptions.supportsPromptAttachments: true`; initialization then advertises
`AcpInitializeResult.promptAttachments: true`. The gateway's `prompt` receives
the validated attachments along with the authored text. Plain text requests are
unchanged. Clients must check the capability before sending attachment bytes.

This boundary accepts at most eight attachments and 3 MiB of decoded bytes per
message. Images use inline bytes; documents use inline text or PDF bytes.
Stored attachment references are refused because this transport does not own
the caller's attachment store. Unsupported attachment requests fail before the
gateway starts a turn. The CLI opts in and preserves attachments through its
actual user-message and history path.
The CLI refuses new image or document inputs before its send when its active
provider explicitly declares that media unsupported. Transport attachment
support alone does not establish model capability.

`AcpSessionPromptParams.options` optionally accepts `AcpPromptOptions` with
`effort?: ReasoningEffort` and `permissionMode?: ReviewMode`. The host opts in with
`supportsPromptOptions: true`, advertised as `promptOptions: true` at
initialization. Unknown fields, invalid modes and unsupported explicit options
are refused before execution. The CLI validates effort against the selected
session's actual provider menu, including its configured fallbacks, and applies
the captured review mode to that message's turn. These options do not rewrite
saved global preferences or change a currently running turn.

## Explicit host extensions

`AcpServerOptions.extensions` optionally installs a table of handlers whose names
begin with `namzu/`. Names cannot replace core methods. The installed names are
advertised in `AcpInitializeResult.extensions`. Extension calls require initialized
permission negotiation; absent methods return method-not-found without closing
the connection. Handler arguments and return values must be JSON-compatible.

The bridge does not grant a generic shell or filesystem API through extensions.
A host owns each handler's validation and scope. `namzu acp --desktop` opts into the
CLI's [desktop operator methods](../cli/desktop.md). Ordinary `namzu acp` retains
its core method set and does not grant folder trust through protocol messages.

`ACPServer.getSessionCwd(sessionId)` provides a read-only lookup of the absolute
workspace bound to a session published on that connection. It returns `undefined`
for unknown IDs, reserved in-flight loads and stopped servers. A newly published
ordinary session need not have a durable journal yet: hosts can use this exact
binding to authorize provider/model preparation before its first turn. This
lookup does not grant filesystem trust, prove persisted history or bypass Pal
claims. The CLI retains durable ownership checks and admits an unrecorded
ordinary session only through this connection-owned, exact canonical workspace.

## Explicit paused-turn recovery

Embedding hosts can implement optional `AcpAgentGateway.retry(request)` and call
`ACPServer.retrySession(sessionId, turnId, checkpointId, options?)` from a scoped
host extension. The retry gateway receives the published workspace, cancellation
signal, event route, review asker and history, plus the exact target IDs. It
receives no prompt or attachments. Its result has the same stop-reason and
optional authoritative-history shape as `prompt`.

Retry uses the existing session's single active execution slot. An ordinary
prompt and a retry exclude each other; `session/cancel`, ordered updates,
permission negotiation and review delivery apply to both. Unknown sessions,
unsupported gateways and invalid options are refused. The bridge does not decide
whether a durable failure is safe to retry; the host must revalidate the original
checkpoint and authority before its runtime resumes it.

`namzu acp --desktop` advertises these extensions when both sides support them:

| Method | Request and result |
| --- | --- |
| `namzu/sessions/retry-status` | `{sessionId}` returns `{retry?: {turnId, checkpointId}, notice?: string}`. Truly idle conversations return `{}`; an active turn without a safe Retry has a notice. |
| `namzu/sessions/retry` | `{sessionId, turnId, checkpointId, options?}` returns `AcpSessionPromptResult` while streaming existing `session/update` notifications. Extra prompt/attachment fields are refused. |

The CLI reads the strict project/tenant-owned journal, verifies the referenced
checkpoint against its recorded hashes, and reads the current original budget
ledger. Only a classified retryable network, server or throttle pause without a
human decision is eligible. Missing, changed, exhausted or unresolved accounting
does not become a new turn. In particular, an unlimited turn with an uncertain
provider request still needs its actual provider usage receipt; Retry does not
reset accounting, manufacture usage or abandon the old turn.

Same-process Retry preserves the paused turn's exact captured approval mode and
effort and pins its recorded model/provider. Initial approval choices are not
currently persisted in the turn snapshot: after reconnection, status reports that
they cannot be verified instead of exposing a default Retry. A direct ordinary-conversation host retry
can deliberately supply an explicit `permissionMode` as new operator consent;
omitting it is refused. This does not grant a parked human decision. Owned Pal
resume retains its current identity, model, writer, pause and operator-control
checks. The CLI captures the original ready computer's generation and
`environmentId` before the original send, preserves that immutable tuple at its
pause, and rechecks it in status, retry admission and each resumed provider/guest
entry. A changed or unavailable original lifetime is refused; a new computer is
never accepted as proof of the original one. That tuple is not currently durable,
so a cold or originally offline Pal checkpoint remains blocked even when an
explicit permission mode is supplied. Another active Pal conversation blocks
admission.

Stdout is reserved for JSON-RPC lines. Human logs go to stderr. Disconnect cancels
owned prompts and rejects pending permission requests.
