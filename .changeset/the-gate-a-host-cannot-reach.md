---
'@namzu/sdk': patch
---

`requireOpenProject` is reachable from the package root.

It was exported from the manager barrel and never re-exported by the package
entry point, so `import { requireOpenProject } from '@namzu/sdk'` was
`undefined` in 14.0.0 — found by running the published tarball rather than the
working tree.

`ProjectManager.requireOpen` always worked and covers the same check, so
nothing was broken; what was missing is the shape the function exists for. A
host writing its own ingress path — a custom handoff, a queue consumer that
creates sessions — should be able to refuse a closed workspace without
constructing a manager, which is precisely why the SDK's own three gates call a
function over a store rather than a method on an injected collaborator.
