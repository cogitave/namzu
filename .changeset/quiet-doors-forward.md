---
'@namzu/sdk': minor
'@namzu/project': patch
---

runAgent forwards skills and the verification gate

`runAgent` built its `drainQuery` call with an `as never` cast. The cast was
not load-bearing — removing it typechecks clean — but while it was there the
kernel seam was unchecked in both directions, and two options the kernel
accepts were never forwarded.

**`skills`** is the one with a caller. `@namzu/project` reads a whole `skills/`
directory, puts them on the options, and every one was dropped: the run was
assembled without them and nothing reported it. If you passed `skills` to
`runAgent` and wondered why the model behaved as though it had never seen them,
this is why. No change needed on your side — the field now arrives.

**`verificationGate`** is the safety one. The kernel builds a `VerificationGate`
from it and consults it on every tool call; the front door had no way to supply
one, so a `runAgent` run was strictly less mediated than a `drainQuery` run. A
host that hands `runAgent` an agent directory it did not write should now set
it.

Both are optional and default to today's behaviour, so nothing breaks.

Three fixes in `@namzu/project`, each a check that existed and read the wrong
thing:

- **A tool with no `inputSchema` is refused.** It used to pass `isToolDefinition`
  — which checked only `name` and `execute` — register clean, then die inside
  `toLLMTools()` on `inputSchema._def`, in a `TypeError` naming neither the tool
  file nor the loader. The check is now the four fields `ToolDefinition`
  declares as required, and no more: demanding `defineTool`'s extras would make
  the loader refuse an object the SDK's own published type accepts. A directory
  that previously loaded with `ok: true` and crashed on first use now loads with
  `ok: false` and a `not_a_tool` diagnostic naming the file.
- **Import failures explain themselves again.** `explainImportFailure` chose its
  hint by matching Node's error code against `err.message`, and Node does not
  put the code in the message — probed: `ERR_MODULE_NOT_FOUND` arrives as
  "Cannot find module …". Every hint in the function was unreachable. It reads
  `err.code` now, and a Node too old for type stripping gets a hint of its own.
- **`metadata` values are checked.** Typed `Record<string, string>` and admitted
  on `typeof === 'object'` alone, which an array also satisfies and which says
  nothing about the values, so `{ count: 1 }` and `["a"]` both reached a
  consumer that had been promised strings.
