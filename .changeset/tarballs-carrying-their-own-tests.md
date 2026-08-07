---
'@namzu/cli': patch
'@namzu/sdk': patch
'@namzu/computer-use': patch
'@namzu/files': patch
'@namzu/sandbox': patch
'@namzu/telemetry': patch
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/http': patch
'@namzu/lmstudio': patch
'@namzu/ollama': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
---

Published tarballs no longer contain test files.

`files: ["dist", "src", ...]` reads as "the build output and the sources" and
means "everything the compiler emitted and everything in the tree", so every
compiled test, its declaration, and both source maps shipped to the registry —
and for the twelve packages that also ship `src`, the raw test sources went with
them.

Measured on the versions currently published:

| package | files | of which tests | unpacked |
| --- | --- | --- | --- |
| `@namzu/sdk` | 3879 → 2239 | 1640 (42%) | 12.73 MB → 6.81 MB |
| `@namzu/cli` | 462 → 282 | 180 (39%) | 1.21 MB → 0.73 MB |

Nothing you can import changes. Every package restricts `exports` to `"."`, so
Node refused a deep subpath into those files already — they were weight in the
tarball and nothing else. Hence `patch`: there is no consumer-visible surface
here, only less to download.

The exclusions are at the packaging layer, not the compiler. Adding `exclude`
to `tsconfig.json` would have kept tests out of `dist` and also dropped them
from `tsc --noEmit`, silently ending type-checking of the entire test suite —
trading a packaging defect for a much worse one.
