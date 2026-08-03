---
'@namzu/sdk': minor
---

Context reduction is a real seam now, and `strategy` has three behaviours instead of two.

`compactionConfig.strategy` accepted `'structured' | 'sliding-window' | 'disabled'`, and the runtime asked one question about it: is it `'disabled'`. So `'sliding-window'` — the value a host picks precisely to avoid paying for summarization — ran the full structured pass, LLM verification call included. The config lied, and it lied in the direction of spending money.

`'sliding-window'` now trims: it keeps the recent turns, drops what precedes them, and summarizes nothing. Every survivor is verbatim. For an agent whose state lives outside the transcript — a task queue, a file it keeps editing, a working-memory block the host renders each turn — the paraphrase was only ever cost.

**A host can also supply their own.** `query({ contextReducer })` takes a function: messages and why it is being asked (`'threshold'` — the estimate says the window is filling; `'overflow'` — the provider already rejected the prompt), returning the shorter history or `undefined` for "I cannot shorten this". It may be async, so a reducer can call a model of its own. A reducer outranks the strategy and fully owns reduction for that run; the structured pass does not also run, because two mechanisms editing one history in the same pass cannot both be reasoned about.

Three ways a reducer's answer is declined, and the third is the interesting one. `undefined` is the reducer itself declining. A throw is treated as the same answer and logged — a broken reduction hook should not kill a healthy run, the same way a broken `prepareStep` does not. And a result that leaves a `tool_result` without its `tool_use` is **refused rather than repaired**: installing it would trade a nameable "your reducer split a tool pair" for an opaque provider rejection a call later, with the reducer never implicated.

The built-in reducer keeps the three invariants the type documents: the leading system floor stays, tool pairs stay together, and messages marked `retain` survive. Where no cut below the requested window is safe it takes one above rather than declining — in a multi-step turn every boundary lands on an assistant or tool message, so declining there would fail exactly when the history is longest.

`ConversationManager`, `createConversationManager`, `SlidingWindowManager`, `StructuredCompactionManager` and `NullManager` are **deprecated** and still exported. That interface cannot be implemented correctly: `reduceContext` is documented as reducing the history but takes `Message[]` and returns `boolean`, so the only way to honour it is in-place mutation — and neither shipped implementation does. Both build a shorter array locally, discard it, and return `true`. Nothing in the runtime ever called any of it, which is how an unfulfillable contract survived this long. Use `ContextReducer`.
