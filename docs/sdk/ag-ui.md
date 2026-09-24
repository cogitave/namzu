---
type: Guide
title: AG-UI clients
description: Expose the Namzu kernel through AG-UI SSE with explicit host authentication, history admission, backend and frontend tools, interrupts and resume, and request-owned UI state.
resource: packages/ag-ui/src/index.ts
tags: [sdk, ag-ui, copilotkit, streaming, tools, hitl, interrupts]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# AG-UI clients

`@namzu/ag-ui` adapts the Namzu kernel's events to AG-UI and serves them to
clients such as the official `HttpAgent`. It is an optional leaf package:
the host supplies a trusted SDK query configuration, and the adapter runs
`query` with that configuration.

Install `@namzu/ag-ui` 2.x, `@namzu/sdk >=45.1.0`, and the SDK's Zod v3 peer in a
Node.js 20+ ESM application. `zod` is a peer of `@namzu/ag-ui` too, because
the frontend tools it builds carry a Zod input schema. The adapter pins
`@ag-ui/core` and `@ag-ui/encoder` to `0.0.59`. Tests use the official
`@ag-ui/client` at `0.0.59` to parse SSE, verify event order, and rebuild
messages and state.

## Resolve scope and admit history

`new AGUIAdapter({ createQuery })` takes an `AGUIQueryFactory`. Its context
contains `input: RunAgentInput`, `signal: AbortSignal`, `ui: AGUITurnUI`,
`interrupts`, `frontendTools`, `request?: Request`, `session?` and
`continuation?`. The HTTP handler supplies `request`; `run(input)` does
not. The factory returns `QueryParams` or a promise of them.

This example accepts an application-owned resolver. That resolver must
authenticate `request`, authorize the thread, and select the complete
history that may reach the model. Its returned `params` contain trusted
provider, model, tools, permissions, stores, and native scope. Defining
this function does not create or call a provider.

```ts
import {
  AGUIAdapter,
  AGUIRequestError,
  toNamzuMessages,
  type AGUIMessage,
  type QueryParams,
  type RunAgentInput,
} from '@namzu/ag-ui'

type ResolveAuthorizedThread = (
  request: Request,
  input: RunAgentInput,
  signal: AbortSignal,
) => Promise<{
  params: QueryParams
  admittedMessages: readonly AGUIMessage[]
}>

export function createAgentEndpoint(resolveAuthorizedThread: ResolveAuthorizedThread) {
  const adapter = new AGUIAdapter({
    async createQuery({ request, input, signal }) {
      if (!request) throw new AGUIRequestError('An HTTP request is required.', 400)
      const authorized = await resolveAuthorizedThread(request, input, signal)
      return {
        ...authorized.params,
        messages: toNamzuMessages(authorized.admittedMessages),
      }
    },
  })
  return (request: Request): Promise<Response> => adapter.handle(request)
}
```

Use an authenticated tenant plus the external `threadId` as the lookup key
for a server-owned native session: an AG-UI thread is one Namzu session, and
each AG-UI run is a new turn in it. Return the session's real tenant,
project, topic and session UUIDs in `QueryParams`. A thread the host has not
seen before gets a new session; recording `threadId` as the session's
external reference (`origin.externalSessionId`, protocol `ag-ui`, kind
`thread`) lets a later request find it again through
`SessionIndex.resolveExternal('ag-ui', 'thread', threadId)`, and the mapping
survives an index rebuild because it lives in the session log. The adapter
records the client's run id as the new turn's `origin.externalTurnId` and
never uses it as a Namzu id; the wire echoes the external `threadId` and run
id verbatim on every `RUN_*` event. The endpoint requires nonempty external
IDs without requiring UUID syntax.

A session has one active turn at a time. New input on a thread with open
interrupts runs nothing and ends with the same interrupts again (see
[Interrupts](#interrupts)). Any other second request on a thread whose session
still has a turn running or paused ends with `RUN_ERROR` code
`NAMZU_TURN_IN_PROGRESS` and leaves the active turn untouched; the kernel
refuses it with `TurnInProgressError`, which `isTurnInProgressError`
recognises. Never cast external IDs to Namzu ID types, use them
directly as filesystem paths, or turn `forwardedProps` into authorization.

All request fields remain untrusted after schema validation, including
`messages`, `state`, `context`, `tools`, `resume` and `forwardedProps`. The
adapter leaves history admission and persistence to the host. A server
storing canonical history should authorize new input and combine it with
stored history instead of treating an echoed browser transcript as evidence
of earlier tool execution. Avoid appending both a full browser transcript
and the same stored transcript.

`context.signal` belongs to the turn the request starts: it aborts when the
request is cancelled while a run is reading the turn, and it does not abort
because a request that ended with an interrupt later closes. Passing it on as
`params.signal` is safe.

## Convert admitted messages

`toNamzuMessages(messages, options?)` is an explicit conversion helper. It
does not run automatically inside the adapter, authenticate history, or
approve tool calls. Invalid or unsupported history throws `AGUIRequestError`
with status 422 and code `INVALID_MESSAGE_HISTORY`; the public message does
not echo the submitted history.

| Input | Conversion |
| --- | --- |
| User text | Strings remain strings; multiple text parts join with newlines |
| Assistant text and calls | Content and original tool IDs/JSON argument strings are retained |
| Tool results | Matching call ID and content are retained; `error` or `metadata.namzu.isError === true` preserves a failure verdict |
| System/developer roles | Rejected by default; `allowSystemMessages: true` admits them as Namzu system messages |
| Inline image/document parts | Base64 data becomes an SDK attachment; attachment order is retained separately from text |
| Legacy `binary` parts | Inline image, PDF, or plain-text bytes are supported |
| Activity/reasoning messages | Display-only content is omitted |
| URL/file-ID references, audio/video | Rejected; the helper performs no downloads or reference resolution |
| Encrypted conversational content | Rejected; provider replay state is not reconstructed from client claims |

Tool rounds must be complete and unambiguous. Each call needs a unique ID
and valid JSON arguments, followed by exactly one matching result
before another conversational message. Display-only activity/reasoning
messages may occur between these parts. Duplicate message/call IDs,
unmatched results, and unresolved calls are rejected. This converts complete
historical tool rounds; it neither answers an interrupt nor delivers a
frontend tool's result, which the adapter does itself (see
[Interrupts](#interrupts) and [Frontend tools](#frontend-tools)).

An inline document can be admitted without giving the server a URL to fetch:

```ts
import { toNamzuMessages } from '@namzu/ag-ui'

const messages = toNamzuMessages([
  {
    id: 'upload-1',
    role: 'user',
    content: [
      { type: 'text', text: 'Read this note.' },
      {
        type: 'document',
        source: { type: 'data', mimeType: 'text/plain', value: 'aGVsbG8=' },
      },
    ],
  },
])

void messages
```

Set `allowSystemMessages` only for instructions whose authority your host
already established. Keep client context as data; the adapter does not put
it in system instructions or trace metadata.

`toNamzuMessages` does not read an incoming AG-UI message's `id` onto the
converted message's `BaseMessage.id`, even though `fromNamzuMessages` (below)
emits one. A live run's `TEXT_MESSAGE_START`/`CONTENT`/`END` events give the
client a streaming correlation id, minted fresh per request — a different
value from the id `query()` later stamps on the durable `message` record for
that same content. Resending the id the client was actually given would hand
`query()` an id its own session log never recorded under, and the turn would
fail as `stale_cached_history` (`'foreign'`; see [Session log](
session-log.md#a-hosts-cached-messages)). Unifying the two id-minting paths
is tracked separately; until then, sending `id`-carrying history back through
`toNamzuMessages` has no effect — every converted message starts with none,
and `query()` reconciles it the same way it does for any caller that never
adopted `.id`.

## Convert namzu messages for display

`fromNamzuMessages(messages, options?)` converts a namzu history into AG-UI
display messages, for `ui.setInitialMessages` (below). Feed it the session's
own fold (`foldSessionMessages`, or `namzu history`'s own read of the log) —
never a live turn's in-memory messages — so every guardrail rewrite, review
override or structured-output replacement shows as the turn settled it, not
as the model first wrote it. Tool-result blocks are flattened to text with a
placeholder for anything that is not, reasoning and attachments are not
display history, and system messages are omitted.

Each converted message carries the source namzu message's own `id`
(`BaseMessage.id`) when it has one — which a message read from a fold read
always does. `options.idPrefix` (default `namzu-message-`) only names the
fallback for a message with none, such as one a caller constructed itself
and never recorded. This is a one-way, display-only capability: the id is
useful to a host for its own bookkeeping (matching a rating or a comment to
the exact durable message), but is not, today, something `toNamzuMessages`
reads back — see above.

## Reconcile initial display history

Inside `createQuery`, call `ui.setInitialMessages(admittedMessages)` to replace
stale browser display history with a host-authorized AG-UI transcript. The
adapter sends `MESSAGES_SNAPSHOT` after `RUN_STARTED` and before native query
events. It does not echo incoming history automatically.

```ts
import type { AGUIMessage, AGUITurnUI } from '@namzu/ag-ui'

export function reconcileDisplay(ui: AGUITurnUI, authorized: readonly AGUIMessage[]) {
  ui.setInitialMessages(authorized)
}
```

This changes client display history only. Independently supply the admitted
model history in `QueryParams.messages`. Do not include private
system prompts, reasoning or other server-only content in the display snapshot.
The official message schema is checked, message IDs must be nonempty and unique,
and the data is copied before enqueueing. Empty history clears the client view.
Invalid or oversized snapshots and a full event queue publish nothing from that
call. Snapshots use the existing `maxEventBytes` and `maxPendingEvents` limits.

The capability is sealed when `createQuery` returns. Calling it later, including
from a backend tool, throws before enqueueing: replacing history during an open
message or tool lifecycle could remove the object that later deltas refer to.
State and custom-event publication remain available during execution. Like other
UI events, a snapshot is request-scoped and does not persist conversation history.

## Publish state and application events

Each factory invocation receives its own `AGUITurnUI`, initialized with a
detached copy of the request state. Capture it in backend tools or
callbacks created for that request. `state` returns another detached copy;
mutating that copy publishes nothing.

```ts
import { type AGUITurnUI } from '@namzu/ag-ui'

export async function reportIndexing(
  ui: AGUITurnUI,
  reindex: () => Promise<number>,
): Promise<number> {
  ui.setState({ status: 'running', completed: 0 })
  const completed = await reindex()
  ui.patchState([
    { op: 'replace', path: '/completed', value: completed },
    { op: 'replace', path: '/status', value: 'complete' },
  ])
  ui.custom('index.complete', { completed })
  return completed
}
```

`setState` queues `STATE_SNAPSHOT`; `patchState` applies an RFC 6902 patch
atomically and queues `STATE_DELTA`. Invalid patches leave state unchanged,
and prototype mutation paths are rejected. `custom` queues a named `CUSTOM`
event. Values must be JSON; invalid values, queue overflow, and oversize
events throw before changing state. Updates are delivered while the native
source runs, including a slow backend tool. No initial snapshot is emitted
automatically; a run that ends with an interrupt sends a `STATE_SNAPSHOT` of
the turn's state, when it has one, before its `RUN_FINISHED`.

The capability closes when its turn settles or its request is cancelled. A
turn that waits inside a tool for the client (a question, a frontend call)
keeps the capability its tools were built with, so a tool that runs after the
answer still publishes, into whichever run is reading the turn by then.
Retaining it for another turn does not create durable state. Persist state
explicitly on the host and authorize state supplied on the next request.

## Interrupts

A turn that needs something only the client can give ends its AG-UI run with
`RUN_FINISHED` whose `outcome` is `{ type: 'interrupt', interrupts }`, per
the [AG-UI interrupt contract](https://docs.ag-ui.com/concepts/interrupts).
The next run on the thread carries the answers in `RunAgentInput.resume`,
one entry per interrupt, and continues the same native turn.

| Native cause | `reason` | `toolCallId` | `resume` payload when `resolved` | `cancelled` |
| --- | --- | --- | --- | --- |
| A tool call the review policy puts to a person | `tool_call` | the call | `{ approved: boolean, editedArgs?: object, reason?: string }` (and `confirmSandboxEscape?: boolean` for a call that asks to leave the sandbox) | refuses the call |
| `ask_user_question`, or `ToolContext.requestPause` in any tool | `input_required` | the asking call, when the client saw it | `{ selected?: string[], text?: string }`: option ids from `metadata.namzu.options` (each `{ id, label, description?, recommended? }`; `recommended: true` marks the option the model recommends, and its label carries no "(Recommended)" suffix), and text when `allowFreeText`; a bare string is text | the tool reads "the user did not answer" |
| `ToolResult.handoff` (sign-in, CAPTCHA, a takeover of the desktop) | `namzu:handoff` | — | anything; "done, carry on" | the turn is closed (`abandonTurn`) |
| A plan the policy put to the client | `confirmation` | — | `{ approved: boolean, feedback?: string }` | the turn is closed |
| A cadence checkpoint the host's policy paused on | `confirmation` | — | `{ approved: boolean, feedback?: string }` | the turn is closed |
| Any other pause (a provider fault the turn can resume from) | `namzu:paused` | — | anything; try again | the turn is closed |

Each interrupt carries `responseSchema` where the answer has a shape,
`expiresAt` when it has a deadline, and `metadata.namzu` with what a UI needs:
the tool name and the exact input under review, `destructive`, a sandbox
escape or the paths outside the working directory; a question's header,
options, `multiSelect` and `allowFreeText`; a handoff's `detail`. `editedArgs`
replaces the call's arguments whole. The kernel prepares and authorizes the
edited input again, so an authorization rule that routes the new value to
review refuses it rather than run it on an approval given for different
arguments. A refusal's `reason` reaches the model when every call of the batch
was refused; a refusal among approvals reaches it as the standard declined
message.

### Ask the client

Nothing is sent to the client unless the host says so, through the handlers
on `context.interrupts`:

- `interrupts.resumeHandler` is a `ResumeHandler` that asks the client
  whenever a person is needed: questions become `input_required`
  interrupts, a tool review goes through the prompt-mode review policy over
  `params.toolsets` (trusted reads run, everything else is asked about), a plan
  approval is asked about, and a cadence checkpoint continues.
- `interrupts.prompt` is a `ToolReviewPrompt` for `createReviewHandler` and
  `createReviewPolicy`, so any mode, exemption and skill-grant rule the host
  already uses decides, and the client is the person it asks.

A host's own handler that answers `pause` for a review, a plan or a
checkpoint gets the same interrupts; the adapter reads the parked request
from the turn, or from the session log when the handler was swapped
mid-turn. A review the host's own handler paused is put to the client call
by call, every call the authorization gate did not refuse: the adapter does
not know which of them that handler meant to ask about.

```ts
import {
  AGUIAdapter,
  type AGUITurnContext,
  type QueryParams,
} from '@namzu/ag-ui'
import { ToolManager, type Toolset, buildAskUserQuestionTool, createReviewHandler, toolset } from '@namzu/sdk'

/** The host's own scope for a thread, including the session log a resume needs. */
type ThreadScope = (
  context: AGUITurnContext,
) => Promise<Omit<QueryParams, 'toolsets' | 'resumeHandler' | 'messages'>>

export function createInteractiveEndpoint(scope: ThreadScope, hostTools: readonly Toolset[]) {
  const adapter = new AGUIAdapter({
    interrupts: { ttlMs: 15 * 60_000 },
    frontendTools: { allow: ['pick_color'] },
    async createQuery(context) {
      // A question waits no longer than its tool's own deadline.
      const question = {
        ...buildAskUserQuestionTool({ resumeHandler: context.interrupts.resumeHandler }),
        timeoutMs: 15 * 60_000,
      }
      const toolsets = [...hostTools, toolset('ag-ui', [question, ...context.frontendTools])]
      const registry = new ToolManager({ toolsets, messages: () => [] })
      const review = createReviewHandler({
        mode: 'accept-edits',
        prompt: context.interrupts.prompt,
        registry,
      })
      return {
        ...(await scope(context)),
        toolsets,
        messages: [],
        resumeHandler: (request) =>
          request.type === 'tool_review' ? review(request) : context.interrupts.resumeHandler(request),
      }
    },
  })
  return (request: Request): Promise<Response> => adapter.handle(request)
}
```

On a request that answers interrupts or frontend calls, `context.continuation`
names the session and turn being continued (`kind: 'resume'` or
`'tool-results'`). `createQuery` still runs, so the host authorizes the
thread as for any request; the adapter refuses the request
(`AGUI_THREAD_MISMATCH`) when the returned `sessionId` is not the turn's.
The returned `messages` are not read.

### Two ways a turn waits

A review, a plan, a checkpoint, a handoff or a provider fault **pauses** the
native turn: it writes a checkpoint and ends with `turn_paused`. Its answer is
applied by `resumeSession`, which continues exactly that checkpoint with the
answer as the native decision (`approve_tools`, `modify_tools`,
`reject_tools`, `approve_plan`, `continue`), under the same turn id. Nothing
is held in memory between the runs, so this works from another process when
the interrupt records live in a shared store (below). It needs the session's
`sessionLog` (and, when it is not the default beside the log,
`checkpointStore`) in the `QueryParams` of the resuming request; without them
the request is refused with `AGUI_RESUME_UNAVAILABLE`. A refusal of a pause
that has no calls to refuse — a cancelled handoff, a rejected plan — closes
the turn with `abandonTurn` and ends the run with `RUN_ERROR` code
`NAMZU_TURN_ABANDONED`; the thread then takes new input.

When the kernel refuses a resume before acting on the answer, the thread is
not left owing answers nobody can give. A checkpoint that still waits on a
decision the answer did not carry is put to the client as fresh interrupts.
A checkpoint that is gone is closed (`AGUI_INTERRUPT_STALE`) and the thread
takes new input. Any other refusal — another worker holds the session's
lease, a store failed — ends with `AGUI_RESUME_FAILED` and reopens the
interrupts, so the same answer can be sent again.

A question, and a frontend tool's result, **wait inside a tool**. The tool's
park is recorded against a checkpoint, but the turn is not paused: it keeps
running in the process that raised the interrupt, and the answer is handed to
the waiting tool. That process must serve the answer, which the default
in-memory store already implies. The wait lasts `interrupts.ttlMs` (10 minutes
when unset), never longer than 5 seconds before the asking tool's own
deadline (`ToolDefinition.timeoutMs`, else `QueryParams.toolTimeoutMs`, else
the SDK's 2 minutes), and never past the turn's own time limit
(`turnConfig.timeoutMs`), which keeps running while the tool waits: an answer
that arrives after it is never read, because the kernel stops the turn at
its next step. When the wait expires, or the tool stops waiting on its own,
the interrupt expires, the turn is cancelled and the thread takes new input.
An interrupt whose turn is not held by this process — after a restart, or on
another replica — is refused as `AGUI_INTERRUPT_STALE` and closed, so it no
longer blocks the thread.

### What a resume may not do

The interrupt id is minted by the adapter and is the only id the client sees.
A resume entry's `interruptId` is looked up in the host's records and used for
nothing else: the session, turn and checkpoint come from the record. These are
refused before the host is asked for anything, as a stream that opens with
`RUN_STARTED` and ends with `RUN_ERROR`:

| Code | Meaning |
| --- | --- |
| `AGUI_INTERRUPT_UNKNOWN` | No interrupt with that id was raised on this thread. An id from another thread reads the same. |
| `AGUI_INTERRUPT_RESOLVED` | Already answered. A replayed resume, and the loser of two concurrent ones, get this; the answer is applied once. |
| `AGUI_INTERRUPT_EXPIRED` | Past `expiresAt`. An expired interrupt can still be `cancelled`, which is how a thread moves past it. |
| `AGUI_RESUME_INCOMPLETE` | The run's other interrupts are not answered. They stay open. |
| `AGUI_RESUME_INVALID` | An interrupt is answered twice in one resume, or answers span runs. |
| `AGUI_RESUME_PAYLOAD_INVALID` | The payload is not the shape the interrupt asked for. The interrupt stays open. |
| `AGUI_INTERRUPT_STALE` | The turn is no longer waiting for the answer. |
| `AGUI_RESUME_FAILED` | The kernel refused to resume the paused turn for a reason that can pass; the interrupts are open again. |
| `AGUI_THREAD_MISMATCH` | The host resolved the thread to another session. |
| `AGUI_RESUME_UNAVAILABLE` | A paused turn cannot be resumed without its session log. |

New input without `resume` on a thread with open interrupts runs nothing: the
run ends with the same interrupts, under the same ids, so a client that lost
them (a reload, a dropped connection) can still answer. This is decided after
`createQuery`, and only the records of the session the host resolved the
thread to count. The thread id is the client's string, so what one session
is waiting for is neither shown to nor in the way of another that reuses it.
The only refusals made before the host has authenticated the request are
about interrupt ids the client itself sent.

Interrupt records live in an `AGUIInterruptStore`
(`interrupts.store`). The default, `InMemoryAGUIInterruptStore`, keeps up to
10,000 settled records in this adapter, and every open one: an open record is
a turn waiting for its client. A host whose threads must survive a restart,
or that runs several replicas, supplies a store in its own database;
`settle` has to be atomic, because it is what makes an answer apply once, and
`reopen` returns records a refused resume had settled. Keep each record
whole: without its `interrupt`, new input on the thread cannot be answered
with the interrupts again and is refused with `AGUI_INTERRUPT_PENDING`.

At the boundary the adapter sends `STATE_SNAPSHOT` of the turn's state, when
it has one, before `RUN_FINISHED`. It sends no `MESSAGES_SNAPSHOT`: display history belongs to
the host, which can publish one through `ui.setInitialMessages`.

## Frontend tools

A client declares the tools it runs in `RunAgentInput.tools`. Without the
`frontendTools` option every request that declares one is refused with 422
`UNSUPPORTED_FRONTEND_TOOLS`, as before. With it, the declared tools the
host admits become SDK tool definitions on `context.frontendTools`:

```ts
import { AGUIAdapter, type AGUIQueryFactory } from '@namzu/ag-ui'

export function createClientToolEndpoint(createQuery: AGUIQueryFactory) {
  return new AGUIAdapter({
    createQuery,
    frontendTools: {
      // Or a predicate over the declaration.
      allow: ['pick_color', 'navigate'],
      // A declared tool outside the list: 'refuse' (422, the default) or 'omit'.
      unlisted: 'omit',
    },
  })
}
```

The host includes the ones it wants in `params.toolsets`; a definition it does
not include is never offered to the model. A name must be 1 to 64 letters,
digits, `_` or `-`, and unique. The client's `parameters` are shown to the
model as the tool's input schema, unchanged. The definitions are `readOnly`,
because the server only waits, so the review policy lets them through; a
`review` or `deny` authorization rule naming the tool still applies, and a
call the gate denies never reaches the client.

The round trip follows the
[AG-UI frontend tool rules](https://docs.ag-ui.com/concepts/tools), which
are not interrupts:

1. The model calls the tool. The run streams `TOOL_CALL_START`,
   `TOOL_CALL_ARGS` and `TOOL_CALL_END` and ends with `RUN_FINISHED`,
   outcome `success`, the call unanswered. The turn waits inside the tool.
2. The client runs the tool and sends its next run with a `tool` message for
   that `toolCallId`. `content` is the result; `error`, or
   `metadata.namzu.isError: true`, marks it failed.
3. The adapter hands the result to the waiting tool, and the run goes on with
   the model reading it. The server sends no `TOOL_CALL_RESULT` for the call:
   the client already has one.

A run on the thread without that `tool` message is refused as
`AGUI_TOOL_RESULT_REQUIRED`. The result is the client's own word, taken once:
once applied, the same `tool` message in a later run's history is ordinary
history.
Other messages that arrive with the result do not reach the waiting turn.

## Read outcomes and enforce limits

`adapter.run(input, { signal? })` returns an async iterator of official
`BaseEvent` objects. `adapter.handle(request)` accepts POST with
`Content-Type: application/json` and an SSE-compatible `Accept` header, then
returns a Fetch `Response`. A missing `Accept` header is accepted. The host
owns routing, authentication, CORS, and persistence.

| Setting | Default | Scope |
| --- | --- | --- |
| `maxRequestBytes` | 4,194,304 (4 MiB) | HTTP body, including chunked input |
| `maxEventBytes` | 1,048,576 (1 MiB) | JSON event/state size; adapter minimum is 256 |
| `maxPendingEvents` | 128 | Queued application state/custom events per request |
| `interrupts.ttlMs` | 10 minutes for a turn waiting in a tool; none for a paused turn | How long an interrupt can be answered |

All limits must be positive safe integers. Native events are consumed with
bounded demand. The adapter combines HTTP and iterator cancellation with any
signal the trusted query factory supplied. Disconnect or early consumption
termination while a run is reading the turn aborts the native turn and drains
its iterator cleanup. A connection that closes after its run ended with an
interrupt, or with a frontend call unanswered, cancels nothing.

Invalid wire schemas and nonempty frontend `tools` without `frontendTools`
produce HTTP 422 before a turn starts. Invalid JSON state values or
initial state exceeding `maxEventBytes` also produce 422 before the query
factory runs. Bad JSON request bodies produce 400,
oversize bodies 413, unsupported content types 415, unsupported response
formats 406, and non-POST methods 405. A factory may throw
`AGUIRequestError(message, status?, code?)` for an intentionally public
response. Other setup exceptions become a generic 500; `onError` observes
internal exceptions without copying them to the wire. Validation also
applies to direct iteration with `run(input)`, where setup errors reject iteration.

A successful native completion produces `RUN_FINISHED` with
`outcome.type: "success"`, authoritative `result`, and available per-message
token usage. Delivery waits for the native iterator to settle, including
the turn's final records in the session log; the native completion event alone does
not release the successful terminal event. Streamed assistant text may
contain narration or an answer subsequently changed by output review.
Final-answer consumers must use
`RUN_FINISHED.result` (the turn's `turn_completed.result`), or the official client's `runAgent()` result's
`result` field, rather than concatenate text events.

Budget exhaustion, cancellation, guardrail stops, other unsuccessful native
stop reasons, and native failure produce `RUN_ERROR`, with code
`NAMZU_TURN_CANCELED` for a cancellation and `NAMZU_TURN_ERROR` otherwise. A
native pause produces an interrupt (see [Interrupts](#interrupts)).

Open text, tool-input, and iteration lifecycles close before terminal events.
Unexpected EOF produces `NAMZU_STREAM_INCOMPLETE`. Repeated completed
messages/results are not replayed as new content; a retained text prefix
can be completed from its aggregate. A conflicting aggregate produces
`NAMZU_MESSAGE_CONTENT_MISMATCH`. Tool arguments that could not be read, cut
off or malformed (see [Unreadable tool input](unreadable-tool-input.md)),
retain their raw fragments and carry `metadata.namzu.inputTruncated` on
`TOOL_CALL_END`; the normalized fallback object is not presented as the
original call. `inputTruncated` is set for both causes. When the runtime
recorded which, `TOOL_CALL_END` also carries it as `metadata.namzu.inputError`,
the `ToolInputError` from `tool_input_completed`: `reason` is `truncated` or
`malformed`, with `finishReason`, `finishDetail`, `parseError`, `offset`,
`length`, `precedingLength`, `outputTokens` and `reasoningTokens` as the
runtime recorded them. Arguments only the adapter found unparsable, and those from
an `@namzu/sdk` that records no reason, carry `inputTruncated` alone.
Backend tool failures carry `metadata.namzu.isError` on their result. A run
that continues a turn does not announce again the calls an earlier run
announced; their results arrive against the original ids.

`AGUIEventMapper` exposes `start`, `map`, `finish`, `fail`, `interrupt`,
`yieldToClient`, `announceTool`, `paused` and `ended` for hosts that already
consume native `SessionEvent` streams. Supply the external thread and run ids,
and the native turn id when it is known; events from a child session
(`lineage.depth > 0`) are filtered out, so a child's terminal event never ends
its parent. `turn_paused` ends mapping and sets `paused`; end the run with
`interrupt(interrupts)`, or `finish()` reports `RUN_ERROR` code
`NAMZU_TURN_PAUSED`. `carriedToolCalls` and `suppressedResults` continue a
turn in a later run. Each mapper owns one AG-UI run. Private prompts,
reasoning/signatures, raw internal events, checkpoint ids and child sessions
are omitted.

`MESSAGES_SNAPSHOT` built from the session comes from `foldSessionMessages`,
so it shows the answer after any guardrail, review or structured-output
rewrite, never the raw model text the log keeps for audit.

## Connect CopilotKit

CopilotKit's runtime accepts AG-UI agent instances and proxies their streams
to the frontend. Register an official `HttpAgent` pointing at the Namzu
endpoint. This sketch requires CopilotKit in the application; it is not
compiled as a Namzu dependency. See the
official [runtime configuration](https://docs.copilotkit.ai/agno/backend/copilot-runtime)
and [AG-UI proxy flow](https://docs.copilotkit.ai/strands/backend/ag-ui).

```ts sketch
import { HttpAgent } from '@ag-ui/client'
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  InMemoryAgentRunner,
} from '@copilotkit/runtime/v2'

const runtime = new CopilotRuntime({
  agents: { default: new HttpAgent({ url: 'https://your-backend.example/api/agent' }) },
  runner: new InMemoryAgentRunner(),
})
const handler = createCopilotRuntimeHandler({ runtime, basePath: '/api/copilotkit' })
export const GET = handler
export const POST = handler
```

For the v2 multi-route handler, configure `CopilotKitProvider` from
`@copilotkit/react-core/v2` with `runtimeUrl="/api/copilotkit"` and
`useSingleEndpoint={false}`. The registered `default` agent is the default
for the prebuilt UI. Configure and authenticate the runtime-to-agent
connection on the host.

In the page, `useInterrupt({ render })` renders an interrupt and answers it
with `resolve(payload)` or `cancel()`; `useFrontendTool({ name, parameters,
handler })` registers a frontend tool, and CopilotKit runs the handler and
sends the next run with its result. Admit those tools with `frontendTools`.
For a `tool_call` interrupt CopilotKit also appends a `tool` message holding
the resume payload (`{"approved":true}`) to its own transcript, beside the
server's real result; keep model history on the server rather than
rebuilding it from that transcript.

This release supports backend tools, text, steps, shared-state events,
custom events, final outcomes, usage, interrupts and resume, and frontend
tools. It does not implement protobuf transport, SSE replay, an AG-UI
connect/reconnect endpoint, subagent-tree projection, or the
`pendingToolCallIds` and `cancelled` outcomes newer than `@ag-ui/core`
`0.0.59`.

## Source comparison and validation

The implementation is Namzu's own TypeScript adapter. The interrupt and
frontend-tool round trips follow the AG-UI 1.0 specification at
[`e62b348680c41f52a5ea0ed4eb714a6600066fa1`](https://github.com/ag-ui-protocol/ag-ui/tree/e62b348680c41f52a5ea0ed4eb714a6600066fa1/docs/spec/1.0),
whose [frontend tool rules](https://github.com/ag-ui-protocol/ag-ui/blob/e62b348680c41f52a5ea0ed4eb714a6600066fa1/docs/spec/1.0/events/tool-calls.mdx)
say a frontend call ends a completed run, answered by history, and are not an
interrupt. Pydantic AI's AG-UI adapter at
[`f8a5fe56ff6978ee33aaac32e23b88fb93258d4a`](https://github.com/pydantic/pydantic-ai/tree/f8a5fe56ff6978ee33aaac32e23b88fb93258d4a/pydantic_ai_slim/pydantic_ai/ui/ag_ui)
does the same (frontend tools are external deferred calls; only approvals
become interrupts), and its approval payload (`approved`, `editedArgs`,
`reason`; `cancelled` refuses) is the one used here. Unlike it, Namzu refuses
a well-formed id that names no open interrupt instead of ignoring it.
CopilotKit's `useInterrupt` and `useFrontendTool` were read at
[`35766aac0e285f381a880b5fd8ed9e6411024482`](https://github.com/CopilotKit/CopilotKit/tree/35766aac0e285f381a880b5fd8ed9e6411024482/packages/react-core/src/v2/hooks).

Repository tests cover conversion and request rejection, state isolation and
patch validation, streamed lifecycle ordering, tool argument/result
continuity, privacy filtering, bounded payload failures, cancellation, and
the actual official `HttpAgent` against the Fetch/SSE boundary for approval,
denial, edited arguments, cancelled approvals, duplicate, concurrent,
foreign-thread, unknown, incomplete, malformed, expired and stale resumes,
questions (answered, free text, cancelled, expired), handoffs (continued and
cancelled), a provider fault, a host's own cadence pause, state across an
interrupt, and frontend tools (answered, failed, missing result, denied by
the gate, admission). A CopilotKit 1.73.3 React page (`CopilotKitProvider`,
`CopilotChat`, `useInterrupt`, `useFrontendTool`) was driven in headless
Chromium against a local endpoint with a scripted model, once with the
`HttpAgent` handed to the provider directly and once through
`CopilotRuntime` with `InMemoryAgentRunner`: an approval, a frontend tool and
a question each completed. That page is not part of the repository.
