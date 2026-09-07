---
type: Reference
title: Bounded code execution
description: Opt-in JavaScript tool batching, structured results, authority and interpreter resource limits.
resource: packages/sdk/src/tools/builtins/run-code.ts
tags: [sdk, tools, execution]
status: stable
---

# Bounded code execution

`buildRunCodeTool()` creates the opt-in `run_code` tool. A program can call the
run's tools, filter their results and return a compact answer. Local control flow
can avoid repeated model requests. This tool is not in the default builtin set.

```ts
import { buildRunCodeTool, WorkerCodeRuntime } from '@namzu/sdk'

const runCode = buildRunCodeTool({
  runtime: new WorkerCodeRuntime({ maxHostCalls: 40, maxPendingHostCalls: 8 }),
  timeoutMs: 30_000,
  maxOutputBytes: 16 * 1024,
  toolResultMode: 'structured',
})
```

Register the definition in the run's tool registry. The model supplies an async
JavaScript body and a list of intended tool names. Inside it, `await call(name,
input)` invokes a tool, `print(...)` emits bounded text, and `return` supplies the
result. `Promise.all` supports concurrency subject to runtime and registry limits.

## Results and authority

By default, successful `call()` resolves to the tool's `output` string. With
`toolResultMode: 'structured'`, it resolves to `{ output, data? }`, preserving the
tool's structured value when present, including `null`, `false`, zero and empty
strings. A program can filter `result.data` without parsing its display summary.
The tool description tells the model which contract is active. Failed calls
reject in both modes; partial data is not presented as a successful value.

Every request goes through the run-owned dispatch. Requested names are intersected
with the turn's allowed tools. Registry authorization, invocation lineage and
cancellation still apply. The program cannot enlarge its grant. Nested requests
needing an unresolved human decision fail closed; an executing parent cannot
open another review turn. The parent is treated as potentially destructive.

## Interpreter and limits

The default `WorkerCodeRuntime` runs each program in a fresh QuickJS WASM
interpreter inside a Node worker. Guest constructors belong to QuickJS. Node
objects and functions are not exposed; filesystem, network, process, module
loading and host timers are unavailable. Only the JSON tool-call bridge exposes
capabilities. Top-level `undefined` is supported; arbitrary application objects,
cycles and non-JSON values are rejected. The runtime ID remains `worker_threads`.

| Constructor option | Default | Accepted range |
| --- | --- | --- |
| `memoryLimitBytes` | 64 MiB | 16–256 MiB |
| `maxSourceBytes` | 256 KiB | 1 byte–4 MiB |
| `maxValueBytes` | 1 MiB | 1 byte–16 MiB per serialized crossing/return |
| `maxHostCalls` | 100 | 1–10,000, including denied calls |
| `maxPendingHostCalls` | configured total call cap | 1–total call cap |

Limits are finite integers. Memory limits apply to the QuickJS allocator and
imported WASM linear memory, not total Node memory, worker overhead or host tools.
The runtime accepts `timeoutMs` from 1 through 2,147,483,647 and `maxOutputBytes`
from zero through 16 MiB. The tool defaults to 30 seconds and 64 KiB of printed
output. Zero disables nonempty prints. Oversized source and values fail
explicitly. Printing stops at line boundaries and reports truncation; returned
values have a separate cap. Host tools retain their own resource responsibilities.

The parent stops the worker at its deadline even if the interpreter cannot make
progress. Admitted host operations receive cancellation, but an uncooperative
operation may outlive it. Stopping the interpreter does not undo external effects.
Completed programs wait for admitted host operations within the same deadline.
Interpreter globals never persist into the next program.

Applications moving from the earlier Node-evaluated backend must use this
JavaScript/JSON contract and choose explicit limits for larger workloads. A
custom `CodeRuntime` must still satisfy the no-ambient-capability, cancellation
and bounded-execution contract. Shadowing Node globals did not enforce it.

Real-worker tests cover constructor/import denial, async dispatch, structured
filtering, timeout, cancellation and resource exhaustion. These establish specific
properties, not that the interpreter or every host tool is vulnerability-free.
