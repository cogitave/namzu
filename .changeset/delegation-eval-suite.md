---
'@namzu/evals': patch
---

`@namzu/evals` gains the `kernel/delegation` suite: twelve scripted cases that pin what the kernel hands a parent when it delegates (the child's words framed as untrusted, the kernel's own record line after them, a failure that is not an answer), what it does with parallel writers and a finished child that gets a follow-up, and how it refuses past the depth and width caps. It needs an `@namzu/sdk` that carries the turn outcome record on the `Agent` tool; against an older SDK its record-line case fails. Nothing to change on your side.
