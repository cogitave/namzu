---
'@namzu/sdk': major
---

Compaction's model table reported 200k for every Claude model, including the ones whose context window is 1M.

`resolveContextWindow` (and `lookupContextWindow` under it) now answers 1,000,000 for `claude-fable-5`, `claude-mythos-*`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8` and `claude-sonnet-4-6`. It still answers 200,000 for the 4.5 generation (`claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`), for the 3.x models, and for any unlisted `claude-` id.

**What changes for you.** The compaction trigger measures fullness against this window and fires at 0.7 of it. On a 1M model that threshold moves from ~140k to ~700k, so a long run now compacts once where it used to compact several times — and stops discarding its prompt-cache prefix to do it. This is the intended correction: at 200k the trigger was firing at about 14% of the real window.

**If you were relying on the old number,** pass the window explicitly — `contextWindowTokens` on the run config takes precedence over the table and always has:

```ts
{ contextWindowTokens: 200_000 }
```

Do that if your endpoint caps the window below the model's published maximum (an older gateway, a proxy, or a tenant limit). Without it, a run against such an endpoint will now build a larger context than the endpoint accepts and fail with `context_length_exceeded` rather than compacting — which is the case this bump is `major` for.

The values are read off the published model comparison. The durable fix is for a driver to ask the provider for the window per model id instead of consulting a table that drifts every release; this change does not do that.
