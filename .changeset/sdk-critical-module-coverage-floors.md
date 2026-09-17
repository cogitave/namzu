---
"@namzu/sdk": patch
---

Nothing a consumer installs changes. The two new files are `*.test.ts`, which
`package.json#files` excludes from the tarball, and `coverage-config.json`,
which that list does not name at all; runtime behaviour, exports, types and the
packed file list are untouched (`npm pack --dry-run` is unchanged). Take the
version for the number only.

The change is to the repository's coverage gate. `runtime`, `store` and
`manager` -- already test-required, never measured -- gain line and branch
floors taken from a measured baseline, and `persona` and `model-router`
graduate from zero-tested to test-required, with the tests that graduate them.
This affects contributors rather than consumers: an SDK change that drops a
floored module more than three points below what it measured now fails CI.
