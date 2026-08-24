---
"@namzu/sdk": major
---

Make nested and model-authored tool calls source-aware and operation-owned.
Every executor-issued `ToolContext` now identifies a direct, nested, or
`run_code` source; a child receives its own execution id, progress route,
parent lineage and deadline. Durable pauses remain bound to the nearest
model-issued ancestor because that is the call a checkpoint can replay. Nested
success and failure text is passed through the configured tool-output budget
before crossing into the code runtime, while terminal events expose the
original size and truncation metadata.

Custom `CodeRuntime` implementations must migrate their host callback from
`onHostCall(request)` to
`onHostCall(request, {runtimeToolCallId, signal})`, using a per-program unique
id and an operation signal revoked by caller cancellation or the runtime's wall
clock. The SDK root now exports the code-runtime contract, result types,
`HostCallContext`, `WorkerCodeRuntime`, and `HostCallDeniedError` so this
migration requires no deep import. The shipped worker waits for already-started
host calls before claiming an ordinary program completion and preserves exact
abort causes.
