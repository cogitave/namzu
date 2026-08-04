---
'@namzu/sdk': major
'@namzu/anthropic': major
---

Thinking is now resolved per model, `effort` is sendable, and thinking tokens
are reported.

**Thinking on a current model was a failed request, not a degraded one.** The
driver mapped `type: 'enabled'` straight to the wire and everything else to
`disabled`. The vendor rejects a mismatched mode with a 400 rather than
falling back: `thinking.type.enabled` is refused from Claude 4.7 onward,
`adaptive` is refused on 4.5 and earlier, and the always-on models refuse
`disabled`. One body for every model does not compromise quality, it fails.

`ThinkingConfig.type` gains `'adaptive'`, and the Anthropic driver resolves the
declared intent against the model it is about to call — sending the mode that
model accepts, dropping a budget where budgets have no meaning, and omitting
the field entirely rather than asking an always-on model to stop thinking. An
unrecognised model is treated as manual-only, which is the previous behaviour
and keeps a gateway serving an older model working.

**`ThinkingConfig.display` is narrowed to `'summarized' | 'omitted'`**, and now
actually reaches the wire. It was `'full' | 'summarized'`: `'full'` is not a
value any vendor accepts — a declared option that could only ever have been
rejected — and `'omitted'` was missing. It also was not serialized at all,
which matters more than it sounds: `display` defaults to `'omitted'` on newer
models, so a caller wanting to show reasoning received thinking blocks with
empty text and nothing to explain why.

**`effort` is new on `ChatCompletionParams`** — `'low' | 'medium' | 'high' |
'xhigh' | 'max'`. It goes out as `output_config.effort`, a *sibling* of
`thinking` rather than a field inside it, because it shapes the whole response
and one manual-mode model accepts it alongside a token budget; nesting it would
have made that combination unsayable. It is dropped on models that do not
accept it, and refused in the one combination the vendor rejects — thinking
disabled at `xhigh`/`max`.

**`TokenUsage.reasoningTokens`** carries `output_tokens_details.thinking_tokens`
when the vendor reports it. It is a *subset* of `completionTokens`, not an
addition — reasoning is billed as output, so summing it into a total would
double-count. Absent means not reported, never zero: coercing would claim every
turn on every silent driver did no thinking, and streamed events carry the
breakdown only on the final delta.

**Migration.** `display: 'full'` no longer compiles — use `'summarized'`, which
is what it meant. Code passing `thinking: { type: 'enabled', budgetTokens }`
keeps working and is now translated per model instead of rejected by newer
ones. `assertThinkingSupported` in `@namzu/openai` refuses `'adaptive'` as it
already refused `'enabled'`, since that driver implements neither.

Not changed: a report accompanying this work claimed `temperature`, `top_p` and
`top_k` are rejected on 5-series models and should be dropped by the driver.
The Messages reference, the extended-thinking page and the thinking
troubleshooting page document no such restriction, so nothing was implemented —
silently dropping sampling parameters that would have worked is its own defect.
