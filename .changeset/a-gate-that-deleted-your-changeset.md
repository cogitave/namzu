---
'@namzu/cli': patch
---

Running `.github/scripts/verify-consumer-install.sh` deleted every uncommitted changeset in the working tree.

The script rewrites each package manifest to check what would PUBLISH rather than what sits in the tree, so it snapshots the version-carrying files on entry and restores them on exit. The restore does `rm -rf .changeset` and untars the snapshot back.

The snapshot was taken with `git ls-files`, which lists TRACKED files. A changeset you have just written is by definition untracked, so it was never in the snapshot and the `rm -rf` was the last thing that happened to it — silently, by a gate `AGENTS.md` tells every contributor to run before pushing, on the one file that declares what the push is supposed to release. The comment above the restore already stated the rule this broke: a developer's uncommitted edit is not this script's to discard.

`.changeset/` is now snapshotted from disk. The manifests keep `git ls-files`, which is the right tool for them: it finds every tracked manifest wherever a package lives, so a new package directory cannot fall outside the snapshot.

A regression test in `scripts/__tests__/` drives the round trip with one committed and one uncommitted changeset — the distinction the defect turned on — and asserts the script no longer reaches for `git ls-files` on that path. `pnpm test:scripts` now runs every file in that directory rather than one named file, so the next test added there is not silently unrun.
