---
"@namzu/cli": minor
---

`run-stream` terminal `done` events now carry the kernel's settled result in
optional `text`, including an intentionally empty guarded result. Hosts should
use that field for the final answer; earlier deltas can include progress and
answers rejected by verification. Interrupted streams without a settled result
can omit it.

Buffered `namzu run` text and JSON output now use that same final result, fixing
concatenation of intermediate narration and rejected completion claims. Fallback
answer-only history persistence also uses the settled result. Partial output on
provider failure or pause remains available with the existing nonzero exit.
