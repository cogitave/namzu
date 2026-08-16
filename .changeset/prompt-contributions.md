---
'@namzu/sdk': minor
---

The system prompt is open: a contribution registry the assembler consumes, with skills as its first contributor.

`PromptBuilder` assembled a fixed list — base prompt, persona or system prompt, skills, tool section, tier guidance, environment — and every one of those was a branch written into the builder. A capability that needed the model to know something (web tools and their citation rules, a plugin's conventions, a host's house style) had exactly two options: convince somebody to add a branch, or splice it into `systemPrompt` and lose whatever was there.

New: `PromptContribution`, `PromptContributionRegistry`, and the `contributions` field on `PromptBuilderConfig`. Omit it and nothing changes.

**`placement` is not cosmetic.** `static` is the segment the prompt cache keeps and a provider caches across turns; `dynamic` is re-sent every iteration. A contributor whose text varies per turn but declares `static` either invalidates the cached prefix on every iteration — paying full price for a cache that never hits — or gets served the first turn's text forever. The rule: `static` iff the output depends only on things that cannot change inside one run.

Registration order is rendering order, because the prompt is read top to bottom by a model that weights early text more; an order derived from priority numbers would have every contributor arguing about a number. A duplicate id is refused rather than silently overwritten — "my guidance stopped appearing" is the least debuggable failure this could have — and `replace` keeps the original position, because a replacement is a new implementation of the same contribution, not a new one.

Skills is the first contributor, and is rendered **in place** rather than at the tail, so a host that registers the built-in gets the seam and not a reordered prompt. Under a persona it stays inside `assembleSystemPrompt`, whose section ordering places it relative to constraints and output discipline — routing it out would silently reorder every persona-driven prompt.
