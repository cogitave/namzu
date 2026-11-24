import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { FileTaskStore } from './file.js'

/**
 * Real processes, because the point of the lock files is that other processes claim from the same list.
 * Each child is a plain `node` with only the built store; the test awaits their exits.
 */

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const STORE_MODULE = new URL('../../../dist/store/task/file.js', import.meta.url).href

function child(script: string) {
	return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		proc.stdout.on('data', (chunk) => {
			output += chunk
		})
		proc.stderr.on('data', (chunk) => {
			output += chunk
		})
		proc.on('error', reject)
		proc.on('exit', (code) => resolve({ code, output }))
	})
}

function fixture() {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-file-tasks-proc-'))
	roots.push(rootDir)
	return { rootDir, store: new FileTaskStore({ listId: 'team', rootDir }) }
}

// Walks the whole list in the same order as its siblings and claims what it can; prints one line per win.
const CLAIMER = (rootDir: string, owner: string) => `
import { FileTaskStore } from ${JSON.stringify(STORE_MODULE)};
const store = new FileTaskStore({ listId: 'team', rootDir: ${JSON.stringify(rootDir)} });
for (const task of await store.list()) {
  const result = await store.claimTask(task.id, ${JSON.stringify(owner)});
  if (result.ok) console.log('won ' + task.id);
}
`

const CREATOR = (rootDir: string, count: number, sessionId: string, turnId: string) => `
import { FileTaskStore } from ${JSON.stringify(STORE_MODULE)};
const store = new FileTaskStore({ listId: 'team', rootDir: ${JSON.stringify(rootDir)} });
for (let i = 0; i < ${count}; i++) {
  const t = await store.create({ sessionId: ${JSON.stringify(sessionId)}, turnId: ${JSON.stringify(turnId)}, subject: 's' + i });
  console.log('made ' + t.id);
}
`

it('three processes claim ten tasks and each task is claimed exactly once', async () => {
	const { rootDir, store } = fixture()
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	for (let i = 0; i < 10; i++) await store.create({ sessionId, turnId, subject: `task ${i}` })

	const results = await Promise.all(['p1', 'p2', 'p3'].map((o) => child(CLAIMER(rootDir, o))))
	expect(
		results.map((r) => r.code),
		JSON.stringify(results),
	).toEqual([0, 0, 0])

	const won = results.flatMap((r) =>
		r.output
			.split('\n')
			.filter((l) => l.startsWith('won '))
			.map((l) => l.slice(4)),
	)
	expect(won).toHaveLength(10)
	expect(new Set(won).size).toBe(10)

	const tasks = await store.list()
	expect(tasks.every((t) => t.status === 'in_progress' && /^p[123]$/.test(t.owner ?? ''))).toBe(
		true,
	)
	// The owner on disk is the process that reported the win.
	for (const [index, r] of results.entries()) {
		for (const line of r.output.split('\n').filter((l) => l.startsWith('won '))) {
			expect(tasks.find((t) => t.id === line.slice(4))?.owner).toBe(`p${index + 1}`)
		}
	}
})

it('processes creating tasks at once get distinct places and lose none', async () => {
	const { rootDir, store } = fixture()
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	const results = await Promise.all(
		[1, 2, 3].map(() => child(CREATOR(rootDir, 8, sessionId, turnId))),
	)
	expect(
		results.map((r) => r.code),
		JSON.stringify(results),
	).toEqual([0, 0, 0])
	const tasks = await store.list()
	expect(tasks).toHaveLength(24)
	expect(new Set(tasks.map((t) => t.id)).size).toBe(24)
})
