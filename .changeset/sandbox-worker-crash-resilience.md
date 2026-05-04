---
'@namzu/sandbox': patch
'@namzu/sdk': patch
---

Worker `handleExecute` no longer crashes the per-task container when a
single request body is rejected by `resolveWithinWorkspace` (e.g. a host
path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
now returns a typed `400` (or a terminal NDJSON `error` event for
post-headers failures) and the worker stays alive for the next call —
prior behaviour was an unhandled rejection on the `http.createServer`
callback, which on Node ≥ 15 exits the process and gives every
subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

The docker backend's host-side `execViaWorker` and `writeFile` fetches
now surface `error.cause.code` / `cause.message` instead of the
stripped `fetch failed`. The bash builtin no longer forwards
`context.workingDirectory` (a host-side path that has no meaning
inside the sandbox container) as `cwd`; tools that need a sub-cwd
inside the sandbox can be added later via an explicit
`SandboxExecOptions` field.

The SDK's iteration aggregator now derives
`ChatCompletionResponse.toolCalls[i].function.arguments` from each
bucket's parsed input rather than the raw `argsBuf` buffer. When a
provider stream truncates with `stop_reason: "max_tokens"` mid-
`input_json_delta`, downstream `JSON.parse` in
`runtime/query/executor.ts:executeSingle` no longer rejects with the
generic "Invalid JSON in tool arguments" — the tool runs against the
empty parsed object and the input zod schema produces a readable
"<field> is required" error instead.
