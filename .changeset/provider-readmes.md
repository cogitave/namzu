---
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/http': patch
'@namzu/lmstudio': patch
'@namzu/ollama': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
---

Make each driver's README an npm package page rather than its manual.

Every driver README carried its full reference — configuration tables, capability matrices, error surfaces — between 167 and 392 lines of it. That is a reasonable shape for a single-package repository, where the README *is* the documentation, and the wrong one for a package in a monorepo that has a `docs/` tree: it duplicates what the docs say, and nothing checks that the two agree.

The README is now what a reader needs in the first minute — what the driver is, install, one working example, links. The reference moved to `docs/providers/<name>.md`, whole, and its code samples are now compiled against the built SDK by the doc-fence gate on every CI run. They never were before; several did not compile.

No API change.
