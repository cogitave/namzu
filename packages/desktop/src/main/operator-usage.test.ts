import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
const runtimeRequest = RuntimeClient.prototype.request
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	vi.restoreAllMocks()
})

it('forwards the usage notice of a conversation this connection owns and drops the rest', async () => {
	let client!: RuntimeClient
	vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(function (
		this: RuntimeClient,
		method,
		params,
		timeout,
	) {
		client = this
		return runtimeRequest.call(this, method, params, timeout)
	})
	const recorded: DesktopEvent[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-tasks-process.mjs', import.meta.url))],
			env: { ...process.env },
		},
		(event) => recorded.push(event),
	)
	owners.push(owner)
	const project = await owner.openProject(process.cwd())
	await owner.openConversation(project.id, 'cold-session')
	await owner.readyConversation(project.id, 'cold-session')
	await client.request('test/usage', {
		sessionId: 'cold-session',
		contextTokens: 1200,
		contextWindowTokens: 200_000,
		cost: 0.5,
		injected: 'ignored',
	})
	await client.request('test/usage', { sessionId: 'unknown-session', contextTokens: 5 })
	await client.request('test/usage', { sessionId: 'cold-session', compaction: 'started' })
	await client.request('test/usage', 'not an object' as unknown as Record<string, unknown>)
	await client.request('test/usage', { contextTokens: 5 })
	// The round trip of the last request means every earlier frame has been read.
	await client.request('namzu/project/status')
	const usage = recorded.filter((event) => event.kind === 'usage')
	expect(usage).toMatchObject([
		{
			kind: 'usage',
			sessionId: 'cold-session',
			contextTokens: 1200,
			contextWindowTokens: 200_000,
			cost: 0.5,
		},
		{ kind: 'usage', sessionId: 'cold-session', compaction: 'started' },
	])
})
