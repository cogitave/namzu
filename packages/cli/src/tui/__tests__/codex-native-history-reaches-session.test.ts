/** Real Session, kernel, provider and store; decoded transport events are fixtures. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	appendMessages,
	loadConversation,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('keeps native items through a tool continuation, persistence and a new Session, with route isolation', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-codex-native-history-'))
	roots.push(cwd)
	await writeFile(join(cwd, 'note.txt'), 'continuity fixture\n')
	const model = 'gpt-5.6-luna'
	const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`
	const authPath = join(cwd, 'auth.json')
	await writeFile(
		authPath,
		JSON.stringify({ tokens: { access_token: token, account_id: 'fixture-account' } }),
		{ mode: 0o600 },
	)
	const detected: DetectedProvider[] = [
		{
			entry: PROVIDER_REGISTRY.codex,
			source: { kind: 'codex-file', path: authPath },
			apiKey: token,
			codex: {
				accountId: 'fixture-account',
				expiresAt: Date.now() + 3_600_000,
				origin: 'codex-file',
			},
			alternatives: [],
		},
	]
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'codex', model }],
		subagents: { active: [] },
	}
	const reasoning = {
		type: 'reasoning',
		id: 'rs_fixture',
		summary: [],
		encrypted_content: 'opaque-fixture',
	}
	const call = {
		type: 'function_call',
		id: 'fc_fixture',
		call_id: 'call_fixture',
		name: 'read',
		arguments: JSON.stringify({ path: join(cwd, 'note.txt') }),
		status: 'completed',
	}
	const answer = {
		type: 'message',
		id: 'msg_fixture',
		role: 'assistant',
		status: 'completed',
		content: [{ type: 'output_text', text: 'Read the fixture.', annotations: [] }],
	}
	const requests: Array<{ input: Record<string, unknown>[] }> = []
	const create = ProviderRegistry.create.bind(ProviderRegistry)
	vi.spyOn(ProviderRegistry, 'create').mockImplementation((...args) => {
		const result = create(...args)
		const client = (
			result.provider as unknown as { client: { get: unknown; responses: { create: unknown } } }
		).client
		client.get = async () => ({ models: [] })
		client.responses.create = async (request: (typeof requests)[number]) => {
			requests.push(request)
			const first = requests.length === 1
			return (async function* () {
				yield { type: 'response.created', response: { id: `resp_${requests.length}` } }
				if (first) {
					yield { type: 'response.output_item.done', output_index: 0, item: reasoning }
					yield { type: 'response.output_item.added', output_index: 1, item: call }
					yield { type: 'response.output_item.done', output_index: 1, item: call }
				} else {
					yield { type: 'response.output_text.delta', delta: 'Read the fixture.' }
					yield { type: 'response.output_item.done', output_index: 0, item: answer }
				}
				yield {
					type: 'response.completed',
					response: {
						id: `resp_${requests.length}`,
						output: [],
						usage: { input_tokens: 12, output_tokens: 4 },
					},
				}
			})()
		}
		return result
	})
	const store = await openSessions(cwd)
	const sessionId = await startConversation(store)
	const options = {
		cwd,
		scope: {
			sessionId,
			topicId: store.topicId,
			projectId: store.projectId,
			tenantId: store.tenantId,
		},
		stateRoot: store.root,
	}
	const first = await createAgentSession(preferences, detected, options)
	let produced: readonly Message[] | undefined
	try {
		for await (const _event of first.send([createUserMessage('Read note.txt')], {
			onConversationMessages: (m) => {
				produced = m
			},
		})) {
			/* drain */
		}
	} finally {
		await first.close()
	}
	if (!produced) throw new Error('Session did not publish messages')
	await appendMessages(store, sessionId, produced)
	const loaded = await loadConversation(store, sessionId)
	expect(loaded.filter((m) => m.role === 'assistant').map((m) => m.source)).toMatchObject([
		{ replayState: { content: null, items: [reasoning, call] } },
		{ replayState: { content: 'Read the fixture.', items: [answer] } },
	])
	for (const selected of [model, 'gpt-5.6-sol']) {
		const resumed = await createAgentSession(
			{ ...preferences, providers: [{ id: 'codex', model: selected }] },
			detected,
			options,
		)
		try {
			for await (const _event of resumed.send([
				...loaded,
				createUserMessage('Continue from that observation'),
			])) {
				/* drain */
			}
		} finally {
			await resumed.close()
		}
	}
	expect(requests).toHaveLength(4)
	expect(requests[1]!.input).toEqual(expect.arrayContaining([reasoning, call]))
	expect(requests[1]!.input).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'function_call_output',
				call_id: call.call_id,
				output: expect.stringContaining('continuity fixture'),
			}),
		]),
	)
	expect(requests[2]!.input).toEqual(expect.arrayContaining([reasoning, call, answer]))
	expect(requests[2]!.input.filter((i) => i.type === 'function_call')).toHaveLength(1)
	expect(requests[3]!.input.some((i) => i.type === 'reasoning')).toBe(false)
	expect(requests[3]!.input.filter((i) => i.type === 'function_call')).toHaveLength(1)
})
