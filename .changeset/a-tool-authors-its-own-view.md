---
'@namzu/sdk': minor
---

A tool can now say how it should be shown. `ToolDefinition` gains optional `presentCall` and `presentResult`, `defineTool` accepts them, and `createToolPresenter(registry)` is the seam a host resolves through. Three closed view shapes: `generic`, `diff`, `terminal`.

Presentation lived in one host as four free functions switching on a lowercased tool *name* — `name === 'write'` and `name === 'edit'` got a diff, everything else got a truncated string. So a tool that host had never heard of, from an MCP server or a plugin, could not get a diff no matter what it did, and every second host started from the raw arguments and rebuilt the same switch. The tool knows what it is doing; the host knows how its surface renders. Neither knew the other's half.

The union is closed deliberately. An open one would let a tool ask for a rendering no host implements — a request that fails silently at the far end.

`edit` now builds its own diff, and declines to build one for an *insert*: there is no `before` text, and substituting an empty string renders as "the whole file was added", which is a confident wrong picture. Returning `undefined` means "no opinion" and is distinct from returning a generic view, which asserts that a plain label is right.

A presenter that throws yields the generic view and logs one warning naming the tool. It is host-supplied code inside a render path — the same trade a log sink already makes — and silence would make a presenter that never works look like one with no opinion.
