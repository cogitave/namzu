---
"@namzu/sandbox": minor
---

New: sandbox seeds. `ensureSandboxSeed(sandbox, seed, { root })` makes the git
repositories of a `defineSandboxSeed({ name, repositories })` present under
`root` inside any sandbox, through `exec` only. Every call checks each
repository (origin URL, and that its pinned or recorded commit is an ancestor
of HEAD) and clones only what is missing, so running it after each create or
workspace resume costs one check when nothing changed. Drift is refused before
anything is cloned (`onDrift: 'report'` records it instead), and nothing is
ever deleted or re-cloned. `root` is required; on docker, use
`layout.scratch`, not the outputs root. URLs with a user name or password,
`ssh://` and `git@host:path` are refused, so no credential enters the guest.
The guest needs `sh`, `git`, `find`, `mkdir`, `mktemp`, `rm` and GNU `mv`.

Nothing changes for code that does not call it.
