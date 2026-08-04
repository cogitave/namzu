---
'@namzu/cli': patch
---

`namzu eval` now defaults `--dir` to `packages/evals`.

The eval package moved there from the repository root. It is `@namzu/evals`, a
private workspace member like every other package, and it was the only one
living outside `packages/` — so `packages/*` in the workspace file now covers
it and the explicit entry is gone.

Pass `--dir` if your suites live elsewhere; the flag is unchanged.
