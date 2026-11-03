import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerRecord } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { HostAccount, SessionRequest } from '../../workspaces/host.js'
import type { PeerSource } from '../../workspaces/peers.js'
import { fileStore } from '../../workspaces/store.js'
import { conversationInUse, sessionSpec } from '../workspaces.js'

const deps = { env: { PATH: '/bin', CODEX_HOME: '/leaked' }, entry: '/dist/bin.js' }
const accounts: HostAccount[] = [
	{ id: 'openai:free-a', label: 'free-a', provider: 'openai' },
	{
		id: 'codex:work',
		label: 'work',
		provider: 'codex',
		codexHome: '/home/me/.namzu/accounts/codex/work',
	},
]
const request = (over: Partial<SessionRequest> = {}): SessionRequest => ({
	cwd: '/work',
	slot: 's1',
	first: false,
	...over,
})

describe('what a hosted session runs', () => {
	it('gives the command its own options only for the first session', () => {
		const first = sessionSpec(request({ first: true }), deps, accounts, [
			'/dist/bin.js',
			'--model',
			'x',
		])
		expect(first.args).toEqual(['/dist/bin.js', '--model', 'x'])
		expect(sessionSpec(request(), deps, accounts, ['/dist/bin.js', '--model', 'x']).args).toEqual([
			'/dist/bin.js',
		])
	})

	it('names the account a new session was started on', () => {
		const spec = sessionSpec(request({ account: 'openai:free-a' }), deps, accounts, [])
		expect(spec.args).toEqual(['/dist/bin.js', '--account', 'openai:free-a'])
		expect(spec.env.CODEX_HOME).toBe('/leaked')
	})

	it('drops a provider or model chosen through the environment when an account is named', () => {
		const env = { ...deps.env, NAMZU_PROVIDER: 'openai', NAMZU_MODEL: 'm' }
		const withAccount = sessionSpec(
			request({ account: 'codex:work' }),
			{ ...deps, env },
			accounts,
			[],
		)
		expect(withAccount.env.NAMZU_PROVIDER).toBeUndefined()
		expect(withAccount.env.NAMZU_MODEL).toBeUndefined()
		const without = sessionSpec(request(), { ...deps, env }, accounts, [])
		expect(without.env.NAMZU_PROVIDER).toBe('openai')
	})

	it('points a session on a Codex account at that account home, and a plain one away from any other', () => {
		const spec = sessionSpec(request({ account: 'codex:work' }), deps, accounts, [])
		expect(spec.env.CODEX_HOME).toBe('/home/me/.namzu/accounts/codex/work')
		expect(spec.env.NAMZU_WORKSPACE_SLOT).toBe('s1')
		const plain = sessionSpec(request(), deps, accounts, [])
		expect(plain.env.CODEX_HOME).toBe('/leaked')
	})

	it('reopens a conversation and finds the home from the account label it last ran on', () => {
		const spec = sessionSpec(
			request({ resume: 'conv-1', accountLabel: 'work' }),
			deps,
			accounts,
			[],
		)
		expect(spec.args).toEqual(['/dist/bin.js', '--resume', 'conv-1'])
		expect(spec.env.CODEX_HOME).toBe('/home/me/.namzu/accounts/codex/work')
	})

	it('reopens a conversation on the account the session last ran on', () => {
		const spec = sessionSpec(
			request({ resume: 'conv-1', account: 'openai:free-a', accountLabel: 'free-a' }),
			deps,
			accounts,
			[],
		)
		expect(spec.args).toEqual(['/dist/bin.js', '--resume', 'conv-1', '--account', 'openai:free-a'])
	})
})

describe('a conversation open in another terminal', () => {
	const peers = (records: Partial<PeerRecord>[]): PeerSource => ({
		records: () => records as PeerRecord[],
		ping: async () => undefined,
	})

	it('is in use when a live terminal reports it', async () => {
		const busy = await conversationInUse(
			{ cwd: '/nowhere', conversationId: 'conv-1' },
			peers([{ conversationId: 'conv-1', pid: process.pid }]),
			{},
		)
		expect(busy).toBe(true)
	})

	it('is free when the terminal that reported it is gone, and nothing holds its lease', async () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-workspaces-lease-'))
		try {
			const busy = await conversationInUse(
				{ cwd: home, conversationId: 'conv-1' },
				peers([{ conversationId: 'conv-1', pid: 2 ** 22 + 12345 }]),
				{ NAMZU_HOME: home },
			)
			expect(busy).toBe(false)
		} finally {
			removeTempDir(home)
		}
	})
})

describe('the layout file', () => {
	it('is written whole, private to the user, and read back', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-workspaces-file-'))
		try {
			const path = join(dir, 'nested', 'workspaces.json')
			const store = fileStore(path)
			expect(store.load()).toBeUndefined()
			store.save({
				version: 3,
				workspaces: [
					{
						name: 'a',
						cwd: '/a',
						tabs: [{ tree: { session: { label: 'x', conversationId: 'c' } } }],
					},
				],
				focus: { workspace: 0 },
			})
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(
				JSON.parse(readFileSync(path, 'utf8')).workspaces[0].tabs[0].tree.session.conversationId,
			).toBe('c')
			expect(store.load()?.focus).toEqual({ workspace: 0 })
		} finally {
			removeTempDir(dir)
		}
	})

	it('reads a file written by the first version as one tab per session', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-workspaces-old-'))
		try {
			const path = join(dir, 'workspaces.json')
			const legacy = join(dir, 'spaces.json')
			writeFileSync(
				legacy,
				JSON.stringify({
					version: 1,
					spaces: [{ name: 'a', cwd: '/a', sessions: [{ label: 'x' }, { label: 'y' }] }],
					focus: { space: 0, session: 1 },
				}),
			)
			const loaded = fileStore(path, undefined, legacy).load()
			expect(loaded?.version).toBe(3)
			expect(loaded?.workspaces[0]?.tabs).toHaveLength(2)
			expect(loaded?.workspaces[0]?.activeTab).toBe(1)
		} finally {
			removeTempDir(dir)
		}
	})

	it('leaves a file from a newer version untouched and says so once', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-workspaces-newer-'))
		try {
			const path = join(dir, 'workspaces.json')
			const original = `${JSON.stringify({ version: 9, workspaces: [{ anything: true }] })}\n`
			writeFileSync(path, original)
			const said: string[] = []
			const store = fileStore(path, (message) => said.push(message))
			expect(store.load()).toBeUndefined()
			expect(store.load()).toBeUndefined()
			store.save({
				version: 3,
				workspaces: [{ name: 'a', cwd: '/a', tabs: [{ tree: { session: { label: 'x' } } }] }],
			})
			expect(readFileSync(path, 'utf8')).toBe(original)
			expect(said).toHaveLength(1)
			expect(said[0]).toContain('newer version')
		} finally {
			removeTempDir(dir)
		}
	})
})
