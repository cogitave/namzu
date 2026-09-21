---
type: Guide
title: Sandbox seeds
description: Git repositories a host wants present in a sandbox, prepared by an idempotent ensureSandboxSeed step on storage that outlives the sandbox; where the root goes on each backend, what is checked on every call, why the marker is not trusted, the URL rules that keep credentials out of the guest, and how two hosts preparing one disk stay out of each other's way.
resource: packages/sandbox/src/seed/index.ts
tags: [sdk, sandbox, seed, git, kubernetes, docker]
status: draft
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Sandbox seeds

A `SandboxSeed` names git repositories a host wants inside a sandbox.
`ensureSandboxSeed(sandbox, seed, { root })` makes them present under `root`,
doing only what is missing, and reports what it found. Run it after every
create or resume: on storage that outlives the sandbox, the second call only
checks. The idea is ax's workspace repositories, prepared once with a marker on
a durable disk; the code is this package's own.

```ts
import type { Sandbox } from '@namzu/sdk'
import { defineSandboxSeed, ensureSandboxSeed } from '@namzu/sandbox'

const seed = defineSandboxSeed({
	name: 'dev',
	repositories: [
		{ name: 'app', url: 'https://github.com/example/app.git', ref: 'main' },
		{
			name: 'lib',
			url: 'https://github.com/example/lib.git',
			commit: '0123456789abcdef0123456789abcdef01234567',
			dir: 'vendor/lib',
		},
	],
})

export async function prepare(sandbox: Sandbox): Promise<void> {
	const report = await ensureSandboxSeed(sandbox, seed, { root: '/workspace-disk/src' })
	for (const repo of report.repositories) console.log(repo.name, repo.status, repo.commit)
}
```

## Where `root` goes

`root` is required, because the right place depends on the backend:

| Backend | Put `root` on | Kept between creates |
|---|---|---|
| kubernetes workspace | the workspace template's disk mount (the template sets the path; this backend sets no `mountPath`) | yes: prepared once per disk, checked on every resume |
| docker | `layout.scratch`, a host bind | when the host reuses the same scratch path |
| everything else | any writable directory | no: prepared on every create |

**Not the docker working root.** A docker sandbox's `rootDir` is
`layout.outputs`, the bind the host's output collector scans, so repositories
there would appear as user-visible outputs. That is why there is no default.

Baked images and golden snapshots are the operator's way to skip the clone
altogether; a seed does not build them.

## What a call does

Everything goes through `Sandbox.exec`, so a backend's file-root jail does not
matter. The guest needs `sh`, `git`, `find`, `mkdir`, `mktemp`, `rm` and a `mv`
that takes `-T` (GNU coreutils). One preflight probes for all of them and
throws `SandboxSeedError` with `code: 'tool-missing'` naming the one that is
absent.

1. **Check every repository**, in one `exec`: the directory exists, is a git
   repository, its `remote.origin.url` is the seed's URL, and the pinned
   `commit` (or the commit a `ref` resolved to when it was cloned) is an
   ancestor of its HEAD.
2. **Drift is refused before anything is cloned** (`code: 'drift'`), so a
   refusal leaves the root as it was. A different origin, a rewritten history,
   or a directory that is not a repository are all drift. With
   `onDrift: 'report'` the repository is reported `drifted` and left alone.
   Nothing is ever deleted or re-cloned.
3. **Clone what is missing** into `<dir>.namzu-partial-<nonce>`, check out the
   pinned commit if there is one, and move it into place with `mv -T`. A
   `ref` is cloned at depth `depth ?? 1`; a pinned `commit` is cloned with its
   history, and `depth` beside it is refused.
4. **Write the marker** `<root>/.namzu/seed/<name>.json` (the seed's digest and
   the commit each repository resolved to) to a temporary file and move it into
   place.
5. **Remove partial clones older than one hour** under each repository's parent
   directory.

The report is `{ digest, repositories: [{ name, status, commit }] }`, `status`
one of `cloned`, `present` and `drifted`. `sandboxSeedDigest(seed)` is the
digest on its own: SHA-256 over the normalised seed, independent of key order.

`signal` cancels the call and `timeoutMs` is handed to every `exec`; size it
for the largest repository, since a clone is one `exec`.

## The marker is not trusted

The marker lives in guest-writable storage, so an agent can forge it. It is
never the reason a repository is skipped: step 1 runs on every call whatever
the marker says, and the marker only supplies the commit a `ref` resolved to.
A marker value that is not a full commit id is ignored rather than passed to
git, where it could be read as an option.

## No credential enters the guest

`defineSandboxSeed` refuses, with `code: 'invalid'`:

- a URL with a user name or password (`https://token@host/...`), and does not
  repeat it in the error;
- `ssh://` and scp-style `git@host:path`, which would need a private key in the
  guest, and on docker cannot leave the `--internal` network anyway;
- every scheme other than `https://` and `http://`.

`https://` is for public repositories. `http://` is for one path: on the docker
backend the [egress proxy](sandbox-egress.md) upgrades a plain request to HTTPS
and stamps the `brokeredCredentials` configured for that host, so a private
repository is cloned with no token in the guest. A tunnelled `https://` request
cannot carry a brokered credential. On every other backend, private
repositories are out of scope.

## Two hosts, one disk

Two hosts may prepare the same workspace disk at once, and neither takes a
lock. Each clones into its own partial directory; whichever `mv -T` lands
first wins, and the other removes only its own partial and checks the winner's
clone like any present repository. The partial sweep in step 5 only removes
partials older than an hour, which only a crashed call leaves, so a peer's
clone still in progress survives it.

## Tests

`packages/sandbox/src/seed/__tests__/ensure.test.ts` runs the function against
a real `sh` and `git` on local bare repositories, with no network: a fresh
clone, a second call that only checks, an added repository, a pinned commit
and a rewritten history under it, drift refused and reported with nothing
changed, a directory that is not a repository, a forged marker (a missing
repository is still cloned; a foreign commit is drift; a non-commit value never
reaches git), a stale partial swept while a fresh one survives, two concurrent
calls, a missing root, a missing `git`, a guest that cannot run `sh`, a failed
clone, and each URL refusal. The contract suite
(`src/testing/sandbox-conformance.ts`) has a `seed` case that runs when a
caller passes `seed: { url, root }`; no run in this repository passes one yet,
so it has not been run against a live backend.
