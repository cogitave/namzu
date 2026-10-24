/**
 * `.github/scripts/pending-changesets.mjs` answers yes only when the pushed
 * tree carries a pending changeset the Changesets action would version rather
 * than publish, and no to everything else, errors included.
 *
 *   node --test scripts/__tests__/pending-changesets.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { decide, decidePending } from '../../.github/scripts/pending-changesets.mjs'

const TREE = 'a'.repeat(40)
const entry = (name, { mode = '100644', type = 'blob' } = {}) =>
	`${mode} ${type} ${'f'.repeat(40)}\t.changeset/${name}\0`
const listing = (...entries) => entries.join('')
const runner = (output) => () => output

describe('decide', () => {
	it('skips when a changeset is pending', () => {
		const r = decide(TREE, runner(listing(entry('README.md'), entry('config.json'), entry('zen-wires.md'))))
		assert.equal(r.skip, true)
		assert.match(r.reason, /1 pending changeset/)
	})

	it('does not skip with only README.md and config.json', () => {
		const r = decide(TREE, runner(listing(entry('README.md'), entry('config.json'))))
		assert.equal(r.skip, false)
		assert.match(r.reason, /no pending changeset/)
	})

	it('does not skip for an empty listing', () => {
		assert.equal(decide(TREE, runner('')).skip, false)
	})

	it('does not skip when reading the tree fails', () => {
		const r = decide(TREE, () => {
			throw new Error('fatal: not a tree object')
		})
		assert.equal(r.skip, false)
		assert.match(r.reason, /could not read the tree/)
	})

	it('does not skip without a valid tree id', () => {
		assert.equal(decide(undefined, runner(listing(entry('x.md')))).skip, false)
		assert.equal(decide('HEAD; rm -rf', runner(listing(entry('x.md')))).skip, false)
	})

	it('does not skip in pre-release mode', () => {
		const r = decide(TREE, runner(listing(entry('pre.json'), entry('x.md'))))
		assert.equal(r.skip, false)
		assert.match(r.reason, /pre-release/)
	})

	it('does not skip for a changeset that is a symlink or a directory', () => {
		assert.equal(decide(TREE, runner(listing(entry('x.md', { mode: '120000' })))).skip, false)
		assert.equal(decide(TREE, runner(listing(entry('x.md', { mode: '040000', type: 'tree' })))).skip, false)
	})

	it('does not skip for entries outside .changeset or malformed lines', () => {
		assert.equal(decide(TREE, runner('100644 blob abc\tother/x.md\0')).skip, false)
		assert.equal(decide(TREE, runner('garbage\0')).skip, false)
	})

	it('ignores non-markdown files and counts only top-level markdown', () => {
		assert.deepEqual(decidePending(listing(entry('notes.txt'), entry('config.json'))).pending, [])
		assert.deepEqual(decidePending(listing(entry('b.md'), entry('a.md'))).pending, ['a.md', 'b.md'])
	})

	it('passes a non-string listing as no', () => {
		assert.deepEqual(decidePending(undefined).pending, [])
	})
})

describe('the CLI against a real repository', () => {
	const script = join(process.cwd(), '.github/scripts/pending-changesets.mjs')
	const git = (cwd, ...args) =>
		spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

	function repo(files) {
		const dir = mkdtempSync(join(tmpdir(), 'pending-cs-'))
		git(dir, 'init', '-q')
		mkdirSync(join(dir, '.changeset'))
		for (const f of files) writeFileSync(join(dir, '.changeset', f), 'x')
		git(dir, 'add', '-A')
		git(dir, 'commit', '-q', '-m', 'c')
		return dir
	}
	const run = (dir) => {
		const out = join(dir, 'gh-output')
		writeFileSync(out, '')
		const tree = git(dir, 'rev-parse', 'HEAD^{tree}').stdout.trim()
		const r = spawnSync('node', [script, '--tree', tree], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, GITHUB_OUTPUT: out },
		})
		return { status: r.status, output: readFileSync(out, 'utf8') }
	}

	it('exits 0 and writes skip=true for a pending changeset', () => {
		const dir = repo(['README.md', 'config.json', 'my-change.md'])
		try {
			const r = run(dir)
			assert.equal(r.status, 0)
			assert.match(r.output, /^skip=true$/m)
			assert.match(r.output, /^path=no-publish$/m)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('exits 1 and writes nothing when only README and config exist', () => {
		const dir = repo(['README.md', 'config.json'])
		try {
			const r = run(dir)
			assert.equal(r.status, 1)
			assert.equal(r.output, '')
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('exits 1 for a tree id that does not exist', () => {
		const dir = repo(['x.md'])
		try {
			const r = spawnSync('node', [script, '--tree', 'b'.repeat(40)], { cwd: dir, encoding: 'utf8' })
			assert.equal(r.status, 1)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
