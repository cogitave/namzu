---
'@namzu/anthropic': patch
---

an effort level a model does not have is no longer sent

`ThinkingCapability.effort` was a boolean — "does this model take an effort
hint?" — and that was never the question. The ceiling moved twice: `xhigh`
arrived with 4.7, and `max` does not exist below 4.6. The accepted levels are a
**set**, and a flag could not say that `xhigh` is rejected on a 4.6 or that
`max` is rejected on a 4.5.

While it was a flag, both of those went to the wire, and the vendor rejects an
unknown level rather than clamping it — so a caller who set `effort: 'xhigh'`
and pointed at a 4.6 got a failed request, not a slightly different answer.

The driver now checks the level against the model:

| model | accepted levels |
|---|---|
| 4.7 and later, and the always-on families | `low` `medium` `high` `xhigh` `max` |
| 4.6 | `low` `medium` `high` `max` |
| Opus 4.5 | `low` `medium` `high` |
| everything else | none |

A level the model does not have is dropped rather than refused: `effort` shapes
an answer the model will still produce, so a request without it is the same
request at the model's own default — whereas refusing would fail a call that
has a correct answer. The existing rule about disabled thinking at `xhigh`/`max`
is unchanged.

`patch`, not `minor` or `major`: `ThinkingCapability` is internal to this
package. The entry point exports `registerAnthropic`, `AnthropicProvider`,
`ANTHROPIC_CAPABILITIES` and two config types, and the changed field is
reachable from none of them — so no consumer's code compiles differently. What
a consumer sees is only that a request that used to fail now succeeds.

The capability table's tests now cover every currently-served model with its
level set, plus the dated-id shape that previously parsed a release date as a
minor version.
