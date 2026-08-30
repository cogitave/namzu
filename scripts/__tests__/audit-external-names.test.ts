import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const audit = join(here, '..', 'audit-external-names.mjs')
const roots: string[] = []
const forbiddenProse = '# We copied Gemini to shape this interface.\n'

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-name-inventory-'))
	roots.push(root)
	execFileSync('git', ['init', '-q'], { cwd: root })
	mkdirSync(join(root, 'packages/sdk/src'), { recursive: true })
	writeFileSync(join(root, '.gitignore'), '.namzu/\ndist/\n', 'utf8')
	writeFileSync(join(root, 'packages/sdk/src/clean.ts'), 'export const localValue = 1\n', 'utf8')
	execFileSync('git', ['add', '.gitignore', 'packages/sdk/src/clean.ts'], { cwd: root })
	return root
}

function runAudit(root: string) {
	return spawnSync(process.execPath, [audit], { cwd: root, encoding: 'utf8' })
}

test('ignored runtime state is outside the authored-file inventory', () => {
	const root = repository()
	const runtime = join(root, 'packages/sdk/.namzu')
	mkdirSync(runtime, { recursive: true })
	writeFileSync(join(runtime, 'runtime.md'), forbiddenProse, 'utf8')

	const result = runAudit(root)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /No third-party product name/)
})

for (const directory of ['.namzu-cache', '.NAMZU']) {
	test(`a similarly named ${directory} directory remains auditable`, () => {
		const root = repository()
		const path = join(root, 'packages/sdk', directory)
		mkdirSync(path, { recursive: true })
		writeFileSync(join(path, 'authored.md'), forbiddenProse, 'utf8')

		const result = runAudit(root)
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, new RegExp(`packages/sdk/${directory.replace('.', '\\.')}\\/authored\\.md`))
	})
}

test('force-tracked prose remains auditable below an ignored directory', () => {
	const root = repository()
	const runtime = join(root, 'packages/sdk/.namzu')
	mkdirSync(runtime, { recursive: true })
	writeFileSync(join(runtime, 'tracked.md'), forbiddenProse, 'utf8')
	execFileSync('git', ['add', '-f', 'packages/sdk/.namzu/tracked.md'], { cwd: root })

	const result = runAudit(root)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /packages\/sdk\/\.namzu\/tracked\.md/)
})

test('untracked source that is eligible to add is audited', () => {
	const root = repository()
	writeFileSync(join(root, 'packages/sdk/src/new.md'), forbiddenProse, 'utf8')

	const result = runAudit(root)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stderr, /packages\/sdk\/src\/new\.md/)
})

test('an inventoried broken file link is a structural failure', () => {
	const root = repository()
	symlinkSync('missing.md', join(root, 'packages/sdk/src/broken.md'))

	const result = runAudit(root)
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /authored file packages\/sdk\/src\/broken\.md could not be read/)
})

test('failure to obtain the Git inventory is structural', () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-name-no-inventory-'))
	roots.push(root)

	const result = runAudit(root)
	assert.equal(result.status, 2, result.stderr)
	assert.match(result.stderr, /authored-file inventory could not be read/)
})

test('a cached file deleted from the working tree has no prose left to audit', () => {
	const root = repository()
	rmSync(join(root, 'packages/sdk/src/clean.ts'))

	const result = runAudit(root)
	assert.equal(result.status, 0, result.stderr)
})
