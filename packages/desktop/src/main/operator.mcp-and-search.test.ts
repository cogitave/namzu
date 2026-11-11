import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup(env: NodeJS.ProcessEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-mcp-'))
	directories.push(root)
	const log = join(root, 'requests.ndjson')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
		},
		() => {},
		root,
	)
	owners.push(owner)
	const project = await owner.openProject(process.cwd())
	const requests = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
	return { owner, project, requests }
}

const SERVERS = {
	servers: [
		{ name: 'notes', origin: 'your-config', state: 'connected', detail: 'notes-server' },
		{
			name: 'tickets',
			origin: 'project-file',
			state: 'waiting',
			detail: 'node',
			fingerprint: 'abc',
		},
		{ name: 'docs', origin: 'this-project', state: 'failed', reason: 'It did not answer.' },
		{ name: 'bad\u0007name', origin: 'nowhere', state: 'connected' },
		{ name: 'quiet', origin: 'your-config', state: 'idle', fingerprint: 'leaks-only-when-waiting' },
	],
}

it('hands on the engine’s tool server list and drops what it cannot vouch for', async () => {
	const { owner, project } = await setup({ FIXTURE_MCP: JSON.stringify(SERVERS) })
	const view = await owner.mcpServers(project.id)
	expect(view?.servers.map((server) => [server.name, server.state])).toEqual([
		['notes', 'connected'],
		['tickets', 'waiting'],
		['docs', 'failed'],
		['quiet', 'idle'],
	])
	expect(view?.servers[1]).toMatchObject({ fingerprint: 'abc', detail: 'node' })
	expect(view?.servers[2]?.reason).toBe('It did not answer.')
	expect(view?.servers[3]).not.toHaveProperty('fingerprint')
})

it('says nothing when the engine has no tool server list', async () => {
	const { owner, project } = await setup()
	expect(await owner.mcpServers(project.id)).toBeNull()
	await expect(
		owner.approveMcpServers(project.id, [{ name: 'tickets', fingerprint: 'abc' }]),
	).rejects.toThrow('cannot be approved')
})

it('approves exactly the servers it was handed, with their fingerprints, and reads the list again', async () => {
	const { owner, project, requests } = await setup({ FIXTURE_MCP: JSON.stringify(SERVERS) })
	const after = await owner.approveMcpServers(project.id, [{ name: 'tickets', fingerprint: 'abc' }])
	expect(after?.servers).toHaveLength(4)
	const approve = (await requests()).find((request) => request.method === 'namzu/mcp/approve')
	expect(approve?.params).toEqual({ servers: [{ name: 'tickets', fingerprint: 'abc' }] })
	for (const bad of [[], 'tickets', [{ name: 'tickets' }], [{ name: 'x', fingerprint: 5 }], [null]])
		await expect(owner.approveMcpServers(project.id, bad)).rejects.toThrow('Choose')
})

it('searches conversation text through every ready project, bounded and without trusting the reply', async () => {
	const hits = {
		hits: [
			{ sessionId: 'one', excerpt: 'I fixed src/cart.js\u0000 today' },
			{ sessionId: '', excerpt: 'dropped: no id' },
			{ sessionId: 'two', excerpt: 5 },
			{ sessionId: 'three', excerpt: 'x'.repeat(1000) },
		],
	}
	const { owner, requests } = await setup({ FIXTURE_SEARCH: JSON.stringify(hits) })
	const found = await owner.searchConversations('  cart  ')
	expect(found.map((hit) => hit.conversationId)).toEqual(['one', 'three'])
	expect(found[0]?.excerpt).toBe('I fixed src/cart.js today')
	expect(found[1]?.excerpt.length).toBeLessThanOrEqual(240)
	const sent = (await requests()).find((request) => request.method === 'namzu/conversations/search')
	expect(sent?.params).toEqual({ query: 'cart', limit: 20 })
	expect(await owner.searchConversations('c')).toEqual([])
	expect(await owner.searchConversations('y'.repeat(201))).toEqual([])
	await expect(owner.searchConversations(5)).rejects.toThrow('Search for some text')
})

it('searches nothing where the engine cannot', async () => {
	const { owner } = await setup()
	expect(await owner.searchConversations('cart')).toEqual([])
})
