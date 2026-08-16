---
'@namzu/openai': patch
---

Stop shipping an empty module.

`src/strict-schema.ts` has been zero bytes since PR #64. Nothing imported it, it
exported nothing, and the compiler still emitted `dist/strict-schema.js`,
`.d.ts` and both maps for it — five files in the published tarball, holding
nothing, behind a filename that promises the constrained-decoding schema logic.

That logic exists and always did, in `@namzu/sdk`: `assertStrictSchema` refuses a
tool whose schema falls outside the strict subset rather than rewriting it. No
consumer-visible behaviour changes here; `@namzu/openai` exports only `.`, so
the file was never reachable as a subpath either.

`.github/scripts/check-publish-metadata.mjs` now fails on any packed source file
of zero bytes, so the next one is caught before the registry rather than after.
