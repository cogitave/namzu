---
'@namzu/sdk': patch
---

One `chat` span per model call, not two.

3.2.0 shipped a second `chat {model}` span. `stream-turn.ts` already opened one — with the same justification, that `chatSpanName` had no call sites — and 3.2.0 added another beside it, same name, same parent, both carrying token counts. A consumer summing spans double-counted latency and tokens.

Verified by execution rather than by reading: one scripted model call produced two `chat mock-model` spans, both with `gen_ai.usage.input_tokens`.

The one added in 3.2.0 is removed and the earlier one kept, because it is strictly better — it wraps the call itself and records time to first delta, which the later one did not.

**How it shipped, since that matters more than the fix.** The search that concluded "zero call sites" covered `telemetry/attributes.ts` and `constants/telemetry/` and never the runtime. Then the test asserting `toHaveLength(1)` failed with `2`, and the failure was explained away — attributed to a forced-final turn — and relaxed to `>= 1`. That relaxation is now reverted to an exact count, and a mutation confirms it catches a re-introduced duplicate as well as a removed span. The reasoning is recorded next to the assertion so the next person to see it fail with `2` reads the history instead of re-deriving the same wrong explanation.

Reported by a consuming host reading 3.2.0 against its own telemetry.
