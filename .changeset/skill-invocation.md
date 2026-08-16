---
'@namzu/sdk': minor
---

A skill says who may invoke it: the model, the operator, or both.

Every skill was offered to the model and to nobody else, and both halves of that are wrong. A skill only an operator can meaningfully run — "collect a support bundle", "rotate the deploy key" — sat in the model's manifest as something to attempt, and the model would attempt it. A skill that is pure model guidance had no way to be offered to an operator at all.

New: the `invocation` frontmatter field (`model` | `operator` | `both`), `skillInvocation()` and `isInvocableBy()`. `both` is the default because it is what every existing skill silently was, and narrowing one is a decision its author makes rather than one a version bump makes for them.

The field is **optional on `SkillMetadata` and not defaulted at parse**, so a stored skill records what its author wrote rather than what this version happened to default to; the default is resolved in one function, because four readers each writing `?? 'both'` is three chances for them to disagree.

Both sides are driven. `renderSkillsSection` carries only what the model may invoke — including the loaded BODY, since an operator-only skill whose body was pasted in while being absent from the manifest is the worst of both — and returns null rather than an empty manifest block. A new kernel `/skills` command lists only what an operator may invoke, refusing (not reporting zero) when the run has no skills registry.

A value that is not one of the three is **refused at load**. A typo'd `invocaton: operator` that quietly resolved to `both` would put an operator-only skill back in front of the model, which is exactly what the field exists to stop, and the author would have no way to tell.
