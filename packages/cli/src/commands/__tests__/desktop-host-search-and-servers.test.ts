import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	createUserMessage,
	drainQuery,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { addUserMcpServer } from '../../integrations/mcp/user-config.js'
import {
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions, searchExcerpt } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-find-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function runtime() {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
}

async function conversation(answer: string) {
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state, generateSessionId())
	await drainQuery({
		provider: new MockLLMProvider({ responseText: answer }),
		messages: [createUserMessage('Please look at it')],
		toolsets: [],
		agentId: 'fixture',
		agentName: 'Fixture',
		sessionLog: DiskSessionLog.at(state.paths, { sessionId }),
		sessionId,
		tenantId: state.tenantId,
		projectId: state.projectId,
		topicId: state.topicId,
		workingDirectory: cwd,
		turnConfig: { model: 'mock', maxIterations: 2, tokenBudget: 100_000, timeoutMs: 30_000 },
	})
	closeSessions(state)
	return sessionId
}

it('finds a conversation by what its reply said, with a short excerpt, and not by what it did not say', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const cart = await conversation('I fixed the total in src/cart.js so the tax rounds once.')
	await conversation('The header now wraps on narrow screens.')
	try {
		const found = (await host['namzu/conversations/search']({ query: 'CART.js' })) as {
			hits: { sessionId: string; excerpt: string }[]
		}
		expect(found.hits.map((hit) => hit.sessionId)).toEqual([cart])
		expect(found.hits[0]?.excerpt).toContain('cart.js')
		expect(found.hits[0]?.excerpt.length).toBeLessThanOrEqual(160)
		expect(await host['namzu/conversations/search']({ query: 'nothing like this' })).toEqual({
			hits: [],
		})
	} finally {
		await owner.close()
	}
})

it('bounds a search: a short query finds nothing, a long list is capped, odd requests are refused', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	await conversation('alpha one')
	await conversation('alpha two')
	await conversation('alpha three')
	try {
		expect(await host['namzu/conversations/search']({ query: 'a' })).toEqual({ hits: [] })
		const capped = (await host['namzu/conversations/search']({ query: 'alpha', limit: 2 })) as {
			hits: unknown[]
		}
		expect(capped.hits).toHaveLength(2)
		await expect(host['namzu/conversations/search']({ query: 'alpha', limit: 51 })).rejects.toThrow(
			'between 1 and 50',
		)
		await expect(host['namzu/conversations/search']({ query: 'alpha', extra: 1 })).rejects.toThrow(
			'Invalid conversation search',
		)
	} finally {
		await owner.close()
	}
})

it('refuses to search a folder nobody trusted', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	await expect(host['namzu/conversations/search']({ query: 'anything' })).rejects.toThrow(
		'Trust this folder',
	)
	await owner.close()
})

it('cuts an excerpt around the match on one line', () => {
	const long = `${'before '.repeat(30)}Target here${' after'.repeat(40)}`
	const cut = searchExcerpt(`line one\n\n  ${long}`, 'target')
	expect(cut).toContain('Target here')
	expect(cut).not.toMatch(/\n/)
	expect(cut.startsWith('…')).toBe(true)
	expect(cut.endsWith('…')).toBe(true)
	expect(searchExcerpt('short text', 'nothing')).toBe('short text')
})

it('lists tool servers with where they are defined and what state each is in, and approves the waiting ones', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	addUserMcpServer('notes', { command: 'notes-server', args: ['--token', 'SECRET_ARGUMENT'] })
	writeFileSync(
		join(cwd, '.mcp.json'),
		JSON.stringify({
			mcpServers: {
				tickets: { command: 'node', args: ['tickets.js'], env: { KEY: 'SECRET_ENV' } },
				docs: { url: 'https://docs.example/mcp?token=SECRET_QUERY' },
			},
		}),
	)
	type Row = { name: string; origin: string; state: string; detail?: string; fingerprint?: string }
	const read = async () =>
		((await host['namzu/mcp/servers']({})) as { servers: Row[]; error?: string }).servers
	try {
		const first = await read()
		expect(first.map((row) => [row.name, row.origin, row.state])).toEqual([
			['notes', 'your-config', 'idle'],
			['tickets', 'project-file', 'waiting'],
			['docs', 'project-file', 'waiting'],
		])
		expect(first.find((row) => row.name === 'docs')?.detail).toBe('https://docs.example')
		expect(first.find((row) => row.name === 'tickets')?.detail).toBe('node')
		expect(JSON.stringify(first)).not.toMatch(/SECRET/)

		const tickets = first.find((row) => row.name === 'tickets') as Row
		// The entry changes after it was listed: the approval no longer covers it.
		writeFileSync(
			join(cwd, '.mcp.json'),
			JSON.stringify({
				mcpServers: {
					tickets: { command: 'node', args: ['other.js'] },
					docs: { url: 'https://docs.example/mcp?token=SECRET_QUERY' },
				},
			}),
		)
		await host['namzu/mcp/approve']({
			servers: [{ name: 'tickets', fingerprint: tickets.fingerprint }],
		})
		expect((await read()).find((row) => row.name === 'tickets')?.state).toBe('waiting')

		const now = await read()
		await host['namzu/mcp/approve']({
			servers: now
				.filter((row) => row.state === 'waiting')
				.map((row) => ({ name: row.name, fingerprint: row.fingerprint })),
		})
		const after = await read()
		// The engine takes a project's servers instead of the user's whole table once the project
		// has any approved, so the list shows what would start, not what the user's file also holds.
		expect(after.map((row) => [row.name, row.state])).toEqual([
			['tickets', 'idle'],
			['docs', 'idle'],
		])
		await expect(host['namzu/mcp/approve']({ servers: [] })).rejects.toThrow('Choose')
	} finally {
		await owner.close()
	}
})

it('shows a server that connected or failed in a conversation of this project', async () => {
	const owner = runtime()
	vi.spyOn(owner, 'mcpStatus').mockReturnValue({
		connected: ['notes'],
		failed: [{ name: 'broken', reason: 'The server did not answer.' }],
	})
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	addUserMcpServer('notes', { command: 'notes-server' })
	addUserMcpServer('broken', { command: 'broken-server' })
	try {
		const { servers } = await host['namzu/mcp/servers']({})
		expect(servers).toEqual([
			expect.objectContaining({ name: 'notes', state: 'connected' }),
			expect.objectContaining({
				name: 'broken',
				state: 'failed',
				reason: 'The server did not answer.',
			}),
		])
	} finally {
		await owner.close()
	}
})

it('lists nothing for a folder nobody trusted, and says when the settings cannot be read', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	expect(await host['namzu/mcp/servers']({})).toEqual({ servers: [] })
	host['namzu/project/trust']({ confirmed: true, cwd })
	writeFileSync(join(cwd, '.mcp.json'), '{ not json')
	const broken = (await host['namzu/mcp/servers']({})) as { servers: unknown[]; error?: string }
	expect(broken.servers).toEqual([])
	expect(broken.error).toBeTruthy()
	await owner.close()
})
