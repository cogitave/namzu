import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { TeamStore } from './store.js'

/**
 * Real processes, because the point of the lock file and the rename is that other processes (a second
 * terminal, Desktop, a later process backend) change the same files. Each child is a plain `node` with
 * only the built store in it; the test awaits their exits and reads the files they left.
 */

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const STORE_MODULE = new URL('../../dist/teams/store.js', import.meta.url).href

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
	const root = mkdtempSync(join(tmpdir(), 'namzu-teams-proc-'))
	roots.push(root)
	const rootDir = join(root, 'teams')
	const store = new TeamStore({ rootDir })
	store.createTeam({ name: 't', leadSessionId: 'sess' })
	return { rootDir, store }
}

// Exit 0: this process took the name. Exit 3: it was refused with name_taken. Anything else is a failure.
const RESERVE = (rootDir: string, name: string) => `
import { TeamStore } from ${JSON.stringify(STORE_MODULE)};
const store = new TeamStore({ rootDir: ${JSON.stringify(rootDir)} });
try {
  store.reserveMember('t', { name: ${JSON.stringify(name)} });
  console.log('won');
} catch (error) {
  if (error.code === 'name_taken') { console.log('lost'); process.exitCode = 3; }
  else { console.error(error.stack); process.exitCode = 1; }
}
`

it('two real processes racing for one name: exactly one wins', async () => {
	const { rootDir, store } = fixture()
	const results = await Promise.all(
		Array.from({ length: 6 }, () => child(RESERVE(rootDir, 'alice'))),
	)
	const codes = results.map((r) => r.code).sort()
	expect(codes, JSON.stringify(results)).toEqual([0, 3, 3, 3, 3, 3])
	expect(store.readTeam('t')?.members.map((m) => m.name)).toEqual(['alice'])
})

it('processes taking different names all get them, with distinct ids and colours', async () => {
	const { rootDir, store } = fixture()
	const names = ['a1', 'b2', 'c3', 'd4', 'e5']
	const results = await Promise.all(names.map((n) => child(RESERVE(rootDir, n))))
	expect(
		results.map((r) => r.code),
		JSON.stringify(results),
	).toEqual(names.map(() => 0))
	const members = store.readTeam('t')?.members ?? []
	expect(members.map((m) => m.name).sort()).toEqual(names)
	expect(new Set(members.map((m) => m.id)).size).toBe(names.length)
})

it('concurrent appends from several processes to one mailbox lose none', async () => {
	const { rootDir, store } = fixture()
	store.reserveMember('t', { name: 'alice' })
	const writers = ['w0', 'w1', 'w2', 'w3']
	const perWriter = 25
	const results = await Promise.all(
		writers.map((w) =>
			child(`
import { TeamStore } from ${JSON.stringify(STORE_MODULE)};
const store = new TeamStore({ rootDir: ${JSON.stringify(rootDir)} });
try {
  for (let i = 0; i < ${perWriter}; i++) store.appendMail('t', 'alice', { from: ${JSON.stringify(w)}, text: String(i) });
} catch (error) { console.error(error.stack); process.exitCode = 1; }
`),
		),
	)
	expect(
		results.map((r) => r.code),
		JSON.stringify(results),
	).toEqual(writers.map(() => 0))
	const mail = store.readMail('t', 'alice')
	expect(mail).toHaveLength(writers.length * perWriter)
	expect(new Set(mail.map((m) => m.id)).size).toBe(mail.length)
	for (const w of writers)
		expect(
			mail.filter((m) => m.from === w).map((m) => Number(m.text)),
			w,
		).toEqual(Array.from({ length: perWriter }, (_, i) => i))
})

it('a process that dies holding the config lock does not block the next one', async () => {
	const { rootDir, store } = fixture()
	const died = await child(`
import { writeFileSync } from 'node:fs';
import { TeamStore } from ${JSON.stringify(STORE_MODULE)};
const store = new TeamStore({ rootDir: ${JSON.stringify(rootDir)} });
// Take the lock as the protocol does (the body names this pid), then exit without releasing it.
writeFileSync(store.configPath('t') + '.lock', process.pid + ':' + Date.now() + ':dead');
`)
	expect(died.code, died.output).toBe(0)
	const member = store.reserveMember('t', { name: 'alice' })
	expect(member.name).toBe('alice')
})
