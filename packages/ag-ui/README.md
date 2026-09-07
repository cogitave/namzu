# @namzu/ag-ui

Expose the Namzu kernel to AG-UI clients through a typed event iterator or a
Fetch-compatible POST/SSE endpoint. This optional package uses the official
`@ag-ui/core` and `@ag-ui/encoder` packages at `0.0.59`; interoperability tests
exercise the official `@ag-ui/client` `HttpAgent` at the same version.

```bash
pnpm add @namzu/ag-ui @namzu/sdk zod@^3
```

Node.js 20 or later and `@namzu/sdk >=36.0.0` are required.

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
factory receives `{ input, signal, ui, request? }`; `request` is present for
HTTP handling and absent for direct iterator runs. An existing host query
configuration supplies providers, model, tools, stores, permissions, and native
tenant/project/topic/session identity.

Map an authenticated tenant plus `input.threadId` to a server-owned native
session. AG-UI IDs are opaque correlation strings: do not cast them to Namzu
UUID types or use them as storage paths. `input.forwardedProps`, `context`,
messages, and state remain client-controlled data. They do not establish
identity or tool permissions.

History admission is explicit. After selecting or verifying the history your
host permits, call `toNamzuMessages(admittedMessages)` and put it in
`QueryParams.prompt`. The adapter does not automatically trust or replay the
request's history. The helper converts complete tool rounds and inline
image/document data; privileged roles require `allowSystemMessages: true`.

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

## Supported surface

| Capability | Behavior |
| --- | --- |
| Text and backend tools | Native message/call IDs, streamed arguments, results, and iteration steps |
| Final outcome and usage | Successful result and per-message token usage; unsuccessful stops use `RUN_ERROR` |
| State and application events | Snapshots, validated JSON patches, and named custom events |
| Frontend tools | Nonempty request `tools` is rejected with HTTP 422 |
| AG-UI approval resume | Nonempty `resume` is rejected with HTTP 422 |
| Native pause | `namzu.run.paused` custom event followed by `RUN_ERROR`; native resumption remains host-owned |
| Transport | POST with JSON input and SSE output; no protobuf, SSE replay, or AG-UI reconnect endpoint |
| Internal events | Child-run trees, prompts, raw events, reasoning, and provider signatures are not forwarded |

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
that runtime. See the [integration guide](../../docs/sdk/ag-ui.md) for the
admission example, compatibility limits, and linked official configuration.
The repository tests `HttpAgent`; it does not claim a tested React deployment.

Licensed under [FSL-1.1-MIT](LICENSE.md).
