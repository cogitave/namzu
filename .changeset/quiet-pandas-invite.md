---
'@namzu/sdk': minor
---

Adds `runAgent` — a provider, a model and a prompt is now a complete agent run.

`drainQuery` is the kernel's entry point and takes eleven required parameters,
four of which are identity fields that throw when missing. That is the right
shape for a kernel: a run with no tenant is a run no auditor can attribute. It
is the wrong shape for the first thing anybody writes, and the proof was
in-tree — the eval suites, the test files and the CLI each hand-assembled the
same block, which is what a missing front door looks like from the inside.

```ts
const { output } = await runAgent({ provider, model, prompt: 'What is 2 + 2?' })
```

It supplies an environment rather than a new engine: it generates the session
identity a single-tenant local run has no opinion about, defaults the budgets,
and points the working directory at the process's own. Everything it fills in
is an ordinary `drainQuery` parameter, so there is no second code path — a
caller who outgrows it passes more options until they are calling `drainQuery`
in all but name.

The identity comes back on the result, and that pairing is the point.
Generating one silently would make each call its own session — right for a
one-shot and wrong for a conversation, where turn two would start with no
history and nothing would say so. Spread `result.identity` into the next call
to continue the same session.

`model` stays required. `LLMProvider` carries no model — a driver may have been
constructed with one, but the interface does not expose it, so anything
inferred here would be a guess billed to the caller.

Defaults are safe rather than generous, because nobody reads them before their
first runaway loop: 16 iterations, a 200k token budget, a 5-minute timeout.
Each is overridable and named on the option.

The README quick start now shows this instead of a bare `provider.chat()` call
— that example demonstrated an HTTP client, not the kernel.
