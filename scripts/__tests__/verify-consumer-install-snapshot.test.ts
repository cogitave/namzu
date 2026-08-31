/**
 * The one property `.github/scripts/verify-consumer-install.sh` has to hold
 * on a developer's machine: it must give back the tree it was handed.
 *
 * `node:test`, matching `check-log-standard.test.ts` and for the same
 * reason — there is no package to hang a vitest project on here. Run via
 * `pnpm test:scripts`.
 *
 * ## Why this test exists
 *
 * The script snapshots the version-carrying files on entry and restores them
 * on exit, because it deliberately mutates every manifest to check what would
 * PUBLISH rather than what is in the tree. The restore does `rm -rf
 * .changeset` and untars the snapshot back.
 *
 * The snapshot was once taken with `git ls-files`, which lists TRACKED files. An
 * uncommitted changeset is by definition untracked, so it was never in the
 * snapshot and the `rm -rf` was the last thing that happened to it. Running
 * this gate — step 14 of the CI table `AGENTS.md` tells every contributor to
 * work before pushing — silently deleted the file that declares what the push
 * was supposed to release.
 *
 * It is asserted here rather than left to review because the loss is
 * invisible: the gate passes, the tree looks fine, and the missing changeset
 * only surfaces when a release publishes nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'verify-consumer-install.sh')

/**
 * Read the script and exercise its snapshot/restore in isolation.
 *
 * The whole script packs every package and runs an npm install, which takes
 * minutes and needs a registry. What is under test is one pair of shell
 * fragments, so they are extracted and run against a throwaway directory —
 * the same trade `check-log-standard.test.ts` makes by driving the pure AST
 * layer instead of the CLI entry point.
 */
function extract(name: string): string {
	const source = readFileSync(SCRIPT, 'utf8')
	const start = source.indexOf(name)
	assert.notEqual(start, -1, `${name} is no longer in ${SCRIPT} — this test is stale`)
	return source
}

describe('the snapshot/restore round trip', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-snapshot-'))
	after(() => rmSync(scratch, { recursive: true, force: true }))

	it('gives back an UNTRACKED changeset, which is what every new one is', () => {
		const workspace = join(scratch, 'ws')
		const snapshot = join(scratch, 'snap')
		execFileSync('mkdir', ['-p', join(workspace, '.changeset'), snapshot])
		execFileSync('git', ['init', '-q'], { cwd: workspace })

		// One committed and one not, so the test can tell "restored everything"
		// from "restored only what git knew about" — which is exactly the
		// distinction the defect turned on.
		writeFileSync(join(workspace, '.changeset', 'config.json'), '{}')
		execFileSync('git', ['add', '.changeset/config.json'], { cwd: workspace })
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], {
			cwd: workspace,
		})
		writeFileSync(join(workspace, '.changeset', 'brand-new.md'), '---\n---\nnot committed yet\n')

		// The snapshot half, verbatim in shape from the script.
		execFileSync('bash', ['-c', 'cd "$1" && tar cf - .changeset | (cd "$2" && tar xf -)', '_', workspace, snapshot])
		// The restore half, verbatim in shape from the script.
		execFileSync(
			'bash',
			['-c', 'rm -rf "$1/.changeset" && (cd "$2" && tar cf - .) | (cd "$1" && tar xf -)', '_', workspace, snapshot],
		)

		assert.ok(
			existsSync(join(workspace, '.changeset', 'brand-new.md')),
			'an uncommitted changeset did not survive the round trip',
		)
		assert.ok(existsSync(join(workspace, '.changeset', 'config.json')))
	})

	it('the script snapshots .changeset from DISK, not from the index', () => {
		const source = extract('VERSION_SNAPSHOT=$(mktemp')

		// The specific regression. `git ls-files` over `.changeset/*` is what
		// dropped untracked changesets, and it reads as correct at first glance.
		assert.ok(
			!/git ls-files[^\n]*\.changeset/.test(source),
			'`.changeset` is snapshotted through `git ls-files` again, which cannot see an uncommitted changeset',
		)
		assert.ok(
			/tar cf - \.changeset/.test(source),
			'`.changeset` is no longer snapshotted from disk',
		)
	})

	it('still restores the manifests it deliberately rewrites', () => {
		// The other half of the script's contract, asserted so a fix to the
		// above cannot be "stop snapshotting anything". These are read from disk
		// too, so a new untracked package survives the local release preview.
		const source = extract('VERSION_SNAPSHOT=$(mktemp')
		assert.ok(/find packages[\s\S]*-name package\.json/.test(source))
		assert.ok(/find packages[\s\S]*-name CHANGELOG\.md/.test(source))
	})
})
