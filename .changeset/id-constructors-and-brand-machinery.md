---
'@namzu/sdk': minor
---

Ids can now be checked at runtime. `asRunId`, `asSessionId`, `asProjectId`
and one constructor per prefixed id type verify the prefix and throw
`InvalidIdError` — naming both the value and the prefix that was expected —
rather than returning `undefined`. A caller holding a malformed id has no
correct fallback, and the value is usually on its way to becoming a store
key.

There was no prefix check anywhere before this. The casts in the tree assert
without verifying, so a `ses_` value cast to `RunId` reached a store key
unremarked and the first sign of it was a lookup that found nothing. The
types cannot catch it either: every id is a bare template-literal type, so
`const x: RunId = 'run_made-up'` compiles with no cast and no factory call.

One constructor per type rather than a generic `asId(prefix, value)`, on
purpose — a generic loses the return type, which is what makes the call site
type-check.

Also adds `types/ids/brand.ts` with the nominal-brand machinery, **declared
and not applied**. Nothing in `types/ids/index.ts` changes, so no existing
code breaks. Applying the brand turns every bare id literal into an error at
once, which is a major with a migration in front of it.

A comment in `types/ids/index.ts` claiming the actor ids were "branded so
actor refs cannot be constructed from bare strings" is corrected. The
compiler never enforced that, and the sentence had been sitting in the
source as documentation.
