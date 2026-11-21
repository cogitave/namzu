import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')
const WORKER = fileURLToPath(new URL('./__fixtures__/state-writer-worker.ts', import.meta.url))
const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function scratch() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-state-race-'))
	dirs.push(root)
	const userHome = join(root, 'home')
	const markers = join(root, 'markers')
	mkdirSync(join(userHome, '.namzu'), { recursive: true })
	mkdirSync(markers)
	return { root, userHome, markers }
}

function run(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
	const child = spawn(process.execPath, ['--import', TSX_IMPORT, WORKER, ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, NAMZU_HOME: '' },
	})
	children.push(child)
	let stderr = ''
	child.stderr?.on('data', (chunk) => {
		stderr += chunk
	})
	return new Promise((resolve) => {
		child.on('error', (error) => resolve({ code: 1, stderr: error.message }))
		child.on('close', (code) => resolve({ code, stderr }))
	})
}

/** Waits for the file itself; a worker that never gets there is caught by the test's timeout. */
async function until(path: string): Promise<void> {
	while (!existsSync(path)) await setTimeout(10)
}

async function bothWrite(
	kind: 'trust' | 'approvals' | 'config',
	first: { target: string; value: string },
	second: { target: string; value: string },
) {
	const { userHome, markers } = scratch()
	const one = run([kind, 'first', userHome, first.target, first.value, markers])
	await until(join(markers, 'first-inside'))
	const two = run([kind, 'second', userHome, second.target, second.value, markers])
	const [a, b] = await Promise.all([one, two])
	expect(a.code, a.stderr).toBe(0)
	expect(b.code, b.stderr).toBe(0)
	// The second writer did meet the first one's lock: the race really happened.
	expect(existsSync(join(markers, 'second-blocked'))).toBe(true)
	return join(userHome, '.namzu')
}

// Real subprocesses that load TypeScript through tsx: seconds each on a loaded runner, and
// nothing in the outcome depends on how many.
const SUBPROCESS_TIMEOUT_MS = 60_000

describe('two processes changing one state file at once', () => {
	it(
		'keep both trusted folders',
		async () => {
			const a = mkdtempSync(join(tmpdir(), 'namzu-race-a-'))
			const b = mkdtempSync(join(tmpdir(), 'namzu-race-b-'))
			dirs.push(a, b)
			const home = await bothWrite('trust', { target: a, value: '' }, { target: b, value: '' })
			const stored = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8'))
			expect(stored.trusted).toHaveLength(2)
			expect(existsSync(join(home, 'trust.json.lock'))).toBe(false)
		},
		SUBPROCESS_TIMEOUT_MS,
	)

	it(
		'keep both server approvals',
		async () => {
			const project = mkdtempSync(join(tmpdir(), 'namzu-race-project-'))
			dirs.push(project)
			const home = await bothWrite(
				'approvals',
				{ target: project, value: 'alpha' },
				{ target: project, value: 'beta' },
			)
			const stored = JSON.parse(readFileSync(join(home, 'mcp-approvals.json'), 'utf8'))
			const [servers] = Object.values(stored.folders) as Record<string, string>[]
			expect(Object.keys(servers ?? {}).sort()).toEqual(['alpha', 'beta'])
		},
		SUBPROCESS_TIMEOUT_MS,
	)

	it(
		'keep both settings',
		async () => {
			const home = await bothWrite(
				'config',
				{ target: '', value: 'first' },
				{ target: '', value: 'second' },
			)
			const stored = parse(readFileSync(join(home, 'config.yaml'), 'utf8'))
			expect(stored).toEqual({ tui: { first: true, second: true } })
		},
		SUBPROCESS_TIMEOUT_MS,
	)
})
