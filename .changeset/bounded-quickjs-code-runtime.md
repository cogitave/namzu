---
"@namzu/sdk": major
---

Run model-authored JavaScript inside QuickJS in `WorkerCodeRuntime`. Constructor chains can no longer reach Node capabilities through the worker's host realm. The `WorkerCodeRuntime` name and `worker_threads` id remain unchanged, and nested calls retain host authorization, cancellation and result tracking.

Programs must use `call()` for host capabilities: Node modules, Node globals and host timers are unavailable. Inputs and results now cross as JSON-safe values, with top-level `undefined` also supported. Functions, bigint, cycles and non-JSON host objects fail instead of crossing the interpreter boundary.

The default runtime now limits source to 256 KiB, each serialized value to 1 MiB, total and pending host calls to 100, and the QuickJS allocator/WASM linear memory to 64 MiB. This memory limit does not bound total Node or process memory. Printed output remains controlled by `maxOutputBytes`, which accepts zero and now has a 16 MiB ceiling; `timeoutMs` must be a positive integer within Node's timer range.

Consumers requiring different budgets can construct `new WorkerCodeRuntime({ memoryLimitBytes, maxSourceBytes, maxValueBytes, maxHostCalls, maxPendingHostCalls })` within the documented ceilings and pass it as the tool's `runtime`. Consumers requiring additional execution semantics must supply another `CodeRuntime` that meets the no-ambient-capability and wall/output-bound guarantees. Do not rely on the previously reachable Node globals or pass non-JSON objects through host calls.
