# @namzu/ag-ui

Expose the Namzu kernel to AG-UI clients through a typed event iterator or a
Fetch-compatible POST/SSE endpoint. This optional package uses the official
`@ag-ui/core` and `@ag-ui/encoder` packages at `0.0.59`; interoperability tests
exercise the official `@ag-ui/client` `HttpAgent` at the same version.

```bash
pnpm add @namzu/ag-ui @namzu/sdk zod@^3
```

`@namzu/ag-ui` 3.0 requires Node.js 20 or later, `@namzu/sdk >=48.0.0`,
and `zod` 3.

**Compatibility.** Use `@namzu/ag-ui` 2.x with SDK 45.1–47. Version 3.0
expects `QueryParams.toolsets` from SDK 48; replace a `ToolRegistry` in your
`createQuery` result with `toolsets: [toolset(source, definitions)]`.
`@namzu/ag-ui` 2 ends a paused turn's run with an AG-UI
interrupt (`RUN_FINISHED` with `outcome.type: "interrupt"`) and serves
`resume`; 1.x ended it with `RUN_ERROR` code `NAMZU_TURN_PAUSED`.
`@namzu/ag-ui` before 1.0.0 breaks on `@namzu/sdk >=44`, where the kernel's
run events were renamed.

## Connect your existing kernel configuration

Supply a factory that authenticates the caller, resolves its authorized native
scope, and returns trusted `QueryParams`.

```ts
import { AGUIAdapter, type AGUIQueryFactory } from '@namzu/ag-ui'

export function createAGUIHandler(createQuery: AGUIQueryFactory) {
  const adapter = new AGUIAdapter({ createQuery })
  return (request: Request): Promise<Response> => adapter.handle(request)
}
```

Mount the returned handler at your application's agent endpoint. `handle`
accepts JSON `RunAgentInput` over POST and returns `text/event-stream`. The
factory receives `{ input, signal, ui, interrupts, frontendTools, request?,
session?, continuation? }`; `request` is present for HTTP handling and absent
when the host iterates `adapter.run()` directly. An existing host query
configuration supplies providers, model, toolsets, stores, permissions, and native
tenant/project/topic/session identity.

Map an authenticated tenant plus `input.threadId` to a server-owned native
session: an AG-UI thread is a Namzu session, and each AG-UI run is a new turn
in it. AG-UI IDs are opaque correlation strings: do not cast them to Namzu
UUID types or use them as storage paths. The client's `runId` is recorded as
the turn's `origin.externalTurnId` and echoed back verbatim on `RUN_*`
events; it never becomes a Namzu id. A session has one active turn at a time,
so a second run on a thread while its turn is still running or paused ends
with `RUN_ERROR` code `NAMZU_TURN_IN_PROGRESS`. `input.forwardedProps`, `context`,
messages, and state remain client-controlled data. They do not establish
identity or tool permissions.

History admission is explicit. After selecting or verifying the history your
host permits, call `toNamzuMessages(admittedMessages)` and put it in
`QueryParams.messages`. The adapter does not automatically trust or replay the
request's history. The helper converts complete tool rounds and inline
image/document data; privileged roles require `allowSystemMessages: true`.

To reconcile a stale browser transcript, call `ui.setInitialMessages(admittedMessages)`
inside `createQuery`. The adapter publishes a bounded, detached `MESSAGES_SNAPSHOT`
before native query events. This affects the client display only; select model
history independently. Calls after the factory returns are rejected to preserve
active message and tool lifecycles. State and custom events can still stream
throughout the turn.

## Consume events directly

```ts
import { AGUIAdapter, type RunAgentInput } from '@namzu/ag-ui'

export async function finalResult(
  adapter: AGUIAdapter,
  input: RunAgentInput,
  signal?: AbortSignal,
): Promise<unknown> {
  let result: unknown
  for await (const event of adapter.run(input, { signal })) {
    if (event.type === 'RUN_ERROR') throw new Error(String(event.message))
    if (event.type === 'RUN_FINISHED') result = event.result
  }
  return result
}
```

Read `RUN_FINISHED.result` for the authoritative final answer. Streamed text
can precede output review or rewriting; concatenating it does not necessarily
produce the settled result. Successful completion waits for the kernel's
iterator and final persistence to settle.

Backend tools can capture the factory's `ui` and publish snapshots through
`ui.setState(value)`, RFC 6902 updates through `ui.patchState(operations)`, or
application events through `ui.custom(name, value)`. State is isolated per
request; persist it in your application when continuity is required.

## Ask the client

A turn that needs the client ends its run with interrupts, and the next run
answers them in `resume`. Send reviews and questions to the client through the
handlers on the factory's context:

```ts
import { AGUIAdapter, type AGUITurnContext, type QueryParams } from '@namzu/ag-ui'
import { buildAskUserQuestionTool, toolset } from '@namzu/sdk'

/** Your authorized scope, provider and stores for the request's thread. */
type HostParams = (
  context: AGUITurnContext,
) => Promise<Omit<QueryParams, 'toolsets' | 'resumeHandler'>>

export function createInteractiveHandler(hostParams: HostParams) {
  const adapter = new AGUIAdapter({
    frontendTools: { allow: ['pick_color'] },
    async createQuery(context) {
      const toolsets = [toolset('ag-ui', [
        buildAskUserQuestionTool({ resumeHandler: context.interrupts.resumeHandler }),
        ...context.frontendTools,
      ])]
      return {
        ...(await hostParams(context)),
        toolsets,
        resumeHandler: context.interrupts.resumeHandler,
      }
    },
  })
  return (request: Request): Promise<Response> => adapter.handle(request)
}
```

`interrupts.resumeHandler` turns a tool review that needs a person into
`tool_call` interrupts (answered `{ approved, editedArgs?, reason? }`) and a
question into an `input_required` interrupt (answered `{ selected?, text? }`).
`interrupts.prompt` plugs the same into `createReviewHandler`. A tool's
`ToolResult.handoff` becomes a `namzu:handoff` interrupt. Answers are checked
against host-owned records: an unknown, foreign, answered, expired, incomplete
or malformed `resume` ends with `RUN_ERROR` and applies nothing. A paused turn
is continued from its checkpoint with `resumeSession`, which needs the
session's `sessionLog` in the parameters; a question waits inside its tool in
the process that asked it. Records live in memory unless you pass
`interrupts.store`.

Tools the client declares in `RunAgentInput.tools` are refused unless
`frontendTools` admits them. An admitted tool the host registers is called by
the model; the run ends as complete with the call unanswered, and the
client's `tool` message on the next run is its result.

## Supported surface

| Capability | Behavior |
| --- | --- |
| Text and backend tools | Native message/call IDs, streamed arguments, results, and iteration steps |
| Final outcome and usage | Successful result and per-message token usage; unsuccessful stops use `RUN_ERROR` |
| State and application events | Snapshots, validated JSON patches, and named custom events |
| Frontend tools | Admitted by `frontendTools`; otherwise request `tools` is rejected with HTTP 422 |
| Interrupts and resume | Reviews, questions, handoffs and resumable pauses end the run with `outcome.type: "interrupt"`; `resume` continues the same native turn |
| New input with open interrupts | Nothing runs; the run ends with the same interrupts again |
| Concurrent runs on a thread | `RUN_ERROR` code `NAMZU_TURN_IN_PROGRESS`; the active turn is untouched |
| Transport | POST with JSON input and SSE output; no protobuf, SSE replay, or AG-UI reconnect endpoint |
| Internal events | Child sessions, prompts, raw events, reasoning, and provider signatures are not forwarded |

Defaults are a **4 MiB HTTP request body**, **1 MiB per JSON event** and
**128 pending application events**. Configure `maxRequestBytes`,
`maxEventBytes` (minimum 256), and `maxPendingEvents` on the adapter. Limits
must be positive safe integers. Cancellation reaches the kernel and closes the
request-owned UI capability while draining native cleanup. Invalid or oversized
initial state is rejected with HTTP 422 before the query factory runs.
`onError` observes internal exceptions; wire
errors use public messages. Hosts can throw `AGUIRequestError` to select a
deliberately public HTTP error.

For CopilotKit, register an `HttpAgent` pointing at this endpoint in a
`@copilotkit/runtime/v2` agent registry, then connect the React provider to
that runtime; `useInterrupt` answers interrupts and `useFrontendTool` runs
admitted frontend tools. See the [integration guide](../../docs/sdk/ag-ui.md)
for the admission example, interrupt payloads, error codes and compatibility
limits. The repository tests `HttpAgent`; a CopilotKit 1.73.3 page was
driven by hand against it, and is not part of the repository.

Licensed under [FSL-1.1-MIT](LICENSE.md).
