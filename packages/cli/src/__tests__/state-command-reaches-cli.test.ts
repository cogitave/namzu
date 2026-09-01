import { spawnSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const CLI_ENTRY = fileURLToPath(new URL('../bin.ts', import.meta.url))
const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')
const roots: string[] = []

interface Fixture {
	readonly root: string
	readonly home: string
	readonly cwd: string
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'namzu-state-cli-'))
	const home = join(root, 'home')
	const cwd = join(root, 'project')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'config.yaml'), 'not: [valid yaml\n')
	writeFileSync(join(cwd, 'namzu.config.json'), '{not json\n')
	writeFileSync(join(cwd, '.namzu', 'marker'), 'unchanged\n')
	roots.push(root)
	return { root, home, cwd }
}

function run(fixture: Fixture, args: readonly string[]) {
	const {
		NAMZU_FORMAT: _format,
		NAMZU_QUIET: _quiet,
		NAMZU_PROFILE: _profile,
		...env
	} = process.env
	Object.assign(env, { HOME: fixture.home, USERPROFILE: fixture.home })
	const result = spawnSync(process.execPath, ['--import', TSX_IMPORT, CLI_ENTRY, ...args], {
		cwd: fixture.cwd,
		env,
		encoding: 'utf8',
		timeout: 15_000,
	})
	if (result.error) throw result.error
	return result
}

function treeSnapshot(root: string): readonly string[] {
	const out: string[] = []
	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name)
			const key = relative(root, path)
			const stat = statSync(path)
			if (stat.isDirectory()) {
				out.push(`d:${key}`)
				visit(path)
			} else {
				out.push(`f:${key}:${readFileSync(path).toString('base64')}`)
			}
		}
	}
	visit(root)
	return out
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('state command real CLI front door', () => {
	it('reports through structured output without loading or repairing malformed config', () => {
		const f = fixture()
		const before = treeSnapshot(f.root)

		const result = run(f, ['--format', 'json', 'state'])

		expect(result.status).toBe(0)
		expect(result.stderr).toBe('')
		const payload = JSON.parse(result.stdout) as Record<string, unknown>
		expect(payload).toMatchObject({
			version: 1,
			readOnly: true,
			projectConfig: { status: 'present' },
		})
		expect(String(payload.text)).toContain('No files were changed')
		expect(treeSnapshot(f.root)).toEqual(before)
	})

	it('refuses a future mutating action before config loading or state inspection', () => {
		const f = fixture()
		const before = treeSnapshot(f.root)

		const result = run(f, ['state', 'prune'])

		expect(result.status).toBe(64)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('Usage: namzu state [report]')
		expect(result.stderr).not.toContain('config.yaml')
		expect(treeSnapshot(f.root)).toEqual(before)
	})

	it('renders command help even when both config layers are malformed', () => {
		const f = fixture()

		const result = run(f, ['state', '--help'])

		expect(result.status).toBe(0)
		expect(result.stdout).toContain('inspect local Namzu state without changing it')
		expect(result.stderr).toBe('')
	})
})
