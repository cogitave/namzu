---
type: Guide
title: AG-UI clients
description: Expose the Namzu kernel through AG-UI SSE with explicit host authentication, history admission, backend tools, and request-owned UI state.
resource: packages/ag-ui/src/index.ts
tags: [sdk, ag-ui, copilotkit, streaming, tools]
status: stable
---

# AG-UI clients

`@namzu/ag-ui` adapts the Namzu kernel's events to AG-UI and serves them to
clients such as the official `HttpAgent`. It is an optional leaf package:
the host supplies a trusted SDK query configuration, and the adapter runs
`query` with that configuration.

Install `@namzu/ag-ui`, `@namzu/sdk >=36.0.0`, and the SDK's Zod v3 peer in a
Node.js 20+ ESM application. The adapter pins `@ag-ui/core` and
`@ag-ui/encoder` to `0.0.59`. Tests use the official `@ag-ui/client` at
`0.0.59` to parse SSE, verify event order, and rebuild messages and state.

## Resolve scope and admit history

`new AGUIAdapter({ createQuery })` takes an `AGUIQueryFactory`. Its context
contains `input: RunAgentInput`, `signal: AbortSignal`, `ui: AGUIRunUI`, and
`request?: Request`. The HTTP handler supplies `request`; `run(input)` does
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

type ResolveAuthorizedRun = (
  request: Request,
  input: RunAgentInput,
  signal: AbortSignal,
) => Promise<{
  params: QueryParams
  admittedMessages: readonly AGUIMessage[]
}>

export function createAgentEndpoint(resolveAuthorizedRun: ResolveAuthorizedRun) {
  const adapter = new AGUIAdapter({
    async createQuery({ request, input, signal }) {
      if (!request) throw new AGUIRequestError('An HTTP request is required.', 400)
      const authorized = await resolveAuthorizedRun(request, input, signal)
      return {
        ...authorized.params,
        prompt: toNamzuMessages(authorized.admittedMessages),
      }
    },
  })
  return (request: Request): Promise<Response> => adapter.handle(request)
}
```

Use an authenticated tenant plus the external `threadId` as the lookup key
for a server-owned native session. Return its real tenant, project, topic,
and session UUIDs in `QueryParams`. The adapter generates a native run UUID
when the factory does not supply one; the wire retains the external
`threadId` and `runId`. The endpoint requires nonempty external IDs without
requiring UUID syntax. Never cast external IDs to Namzu ID types, use them
directly as filesystem paths, or turn `forwardedProps` into authorization.

All request fields remain untrusted after schema validation, including
`messages`, `state`, `context`, and `forwardedProps`. The adapter leaves
history admission and persistence to the host. A server storing canonical
history should authorize new input and combine it with stored history
instead of treating an echoed browser transcript as evidence of earlier
tool execution. Avoid appending both a full browser transcript and the same
stored transcript.

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
unmatched results, and unresolved calls are rejected. This supports complete
historical backend tool rounds; it does not enable frontend execution or
approval resume.

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

## Reconcile initial display history

Inside `createQuery`, call `ui.setInitialMessages(admittedMessages)` to replace
stale browser display history with a host-authorized AG-UI transcript. The
adapter sends `MESSAGES_SNAPSHOT` after `RUN_STARTED` and before native query
events. It does not echo incoming history automatically.

```ts
import type { AGUIMessage, AGUIRunUI } from '@namzu/ag-ui'

export function reconcileDisplay(ui: AGUIRunUI, authorized: readonly AGUIMessage[]) {
  ui.setInitialMessages(authorized)
}
```

This changes client display history only. Independently supply the admitted
model history in `QueryParams.messages` or `prompt`. Do not include private
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

Initial history reconciliation is tested against the official `HttpAgent` over
Fetch/SSE. It is not an interrupt-boundary snapshot or resume implementation.
The [AG-UI interrupt contract](https://docs.ag-ui.com/concepts/interrupts) also
requires boundary state, correlated responses and replay-safe resolution; these
remain separate work.

## Publish state and application events

Each factory invocation receives its own `AGUIRunUI`, initialized with a
detached copy of the request state. Capture it in backend tools or
callbacks created for that run. `state` returns another detached copy;
mutating that copy publishes nothing.

```ts
import { type AGUIRunUI } from '@namzu/ag-ui'

export async function reportIndexing(
  ui: AGUIRunUI,
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
automatically.

The capability closes when its request settles or is canceled. Retaining it
for another request does not create durable state. Persist state explicitly
on the host and authorize state supplied on the next request.

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

All limits must be positive safe integers. Native events are consumed with
bounded demand. The adapter combines HTTP/run cancellation with any signal
the trusted query factory supplied. Disconnect or early consumption
termination aborts the native run and drains its iterator cleanup.

Invalid wire schemas, nonempty frontend `tools`, and nonempty `resume`
arrays produce HTTP 422 before a run starts. Invalid JSON state values or
initial state exceeding `maxEventBytes` also produce 422 before the query
factory runs. Bad JSON request bodies produce 400,
oversize bodies 413, unsupported content types 415, unsupported response
formats 406, and non-POST methods 405. A factory may throw
`AGUIRequestError(message, status?, code?)` for an intentionally public
response. Other setup exceptions become a generic 500; `onError` observes
internal exceptions without copying them to the wire. Validation also
applies to direct iterator runs, where setup errors reject iteration.

A successful native completion produces `RUN_FINISHED` with
`outcome.type: "success"`, authoritative `result`, and available per-message
token usage. Delivery waits for the native iterator to settle, including
final run and message persistence; the native completion event alone does
not release the successful terminal event. Streamed assistant text may
contain narration or an answer subsequently changed by output review.
Final-answer consumers must use
`RUN_FINISHED.result`, or the official client's `runAgent()` result's
`result` field, rather than concatenate text events.

Budget exhaustion, cancellation, guardrail stops, other unsuccessful native
stop reasons, and native failure produce `RUN_ERROR`. A native pause emits
`CUSTOM` named `namzu.run.paused`, with a checkpoint ID when available,
followed by `RUN_ERROR` code `NAMZU_RUN_PAUSED`. That describes the pause;
it does not advertise AG-UI interrupt resumption. The host separately owns
native checkpoint authorization and resumption.

Open text, tool-input, and iteration lifecycles close before terminal events.
Unexpected EOF produces `NAMZU_STREAM_INCOMPLETE`. Repeated completed
messages/results are not replayed as new content; a retained text prefix
can be completed from its aggregate. A conflicting aggregate produces
`NAMZU_MESSAGE_CONTENT_MISMATCH`. Truncated tool arguments retain their raw
fragments and carry `metadata.namzu.inputTruncated` on `TOOL_CALL_END`;
the normalized fallback object is not presented as the original call.
Backend tool failures carry `metadata.namzu.isError` on their result.

`AGUIEventMapper` exposes `start`, `map`, `finish`, `fail`, and `ended` for
hosts that already consume native `RunEvent` streams. Supply the external
`threadId`/`runId` and the known native `nativeRunId`; matching by native
identity keeps a child's terminal event from ending its parent. Each mapper
owns one run. Private prompts, reasoning/signatures, raw internal events,
and child-run trees are omitted.

## Connect CopilotKit

CopilotKit's runtime accepts AG-UI agent instances and proxies their streams
to the frontend. Register an official `HttpAgent` pointing at the Namzu
endpoint. This sketch requires CopilotKit in the application; it is not
compiled as a Namzu dependency or claimed as a tested React app. See the
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

For the v2 multi-route handler, configure `CopilotKit` from
`@copilotkit/react-core/v2` with `runtimeUrl="/api/copilotkit"` and
`useSingleEndpoint={false}`. The registered `default` agent is the default
for the prebuilt UI. Configure and authenticate the runtime-to-agent
connection on the host. Frontend tool registrations that populate
`RunAgentInput.tools` are unsupported and receive 422.

This release supports backend tools, text, steps, shared-state events,
custom events, final outcomes, and usage. It does not implement frontend
tool execution, AG-UI approval/resume, protobuf transport, SSE replay,
an AG-UI connect/reconnect endpoint, or subagent-tree projection. A
CopilotKit deployment must choose features consistent with that surface.

## Source comparison and validation

The implementation is Namzu's own TypeScript adapter. Design review used
Pydantic AI's AG-UI history/lifecycle separation at
[`a1a42986ca10f5693cf83c9c414e1b57d01f837e`](https://github.com/pydantic/pydantic-ai/tree/a1a42986ca10f5693cf83c9c414e1b57d01f837e/pydantic_ai_slim/pydantic_ai/ui/ag_ui)
and CopilotKit's runtime/client integration at
[`078260605a2ccfa0042fb4d835f36f0c4960fdc6`](https://github.com/CopilotKit/CopilotKit/tree/078260605a2ccfa0042fb4d835f36f0c4960fdc6/packages/runtime).
The AG-UI protocol source inspected was
[`bb34bb684cecfaa54d3ceb4e8f0d4d1c9f46929a`](https://github.com/ag-ui-protocol/ag-ui/tree/bb34bb684cecfaa54d3ceb4e8f0d4d1c9f46929a).

Repository tests cover conversion and request rejection, state isolation and
patch validation, streamed lifecycle ordering, tool argument/result
continuity, privacy filtering, bounded payload failures, cancellation, and
the actual official `HttpAgent` against the Fetch/SSE boundary. These tests
establish interoperability for the supported features; CopilotKit's React
components and a deployed runtime were not exercised.
