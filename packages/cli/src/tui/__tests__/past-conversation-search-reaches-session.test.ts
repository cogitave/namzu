import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { PAST_CONVERSATION_SEARCH_TOOL } from '../../integrations/sessions/past-conversations.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * The past-conversation search is a deferred tool the session mounts when the host owns the
 * conversation storage and `memory.searchPastConversations` is not off. This is the seam where it
 * joins, or stays out of, the roster, and what the request carries either way.
 */

const roots: string[] = []
const opened: AgentSession[] = []
const catalogues: CliSessions[] = []
afterEach(async () => {
	for (const session of opened.splice(0)) await session.close()
	for (const sessions of catalogues.splice(0)) closeSessions(sessions)
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.anthropic,
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

async function run(opts: {
	toolLoading: 'eager' | 'deferred'
	memory?: { searchPastConversations?: boolean }
}) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-past-search-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const provider = new MockLLMProvider({ turns: [{ text: 'Done.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		toolLoading: opts.toolLoading,
		cwd,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		scope: {
			sessionId,
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		},
		sandbox: { enabled: false },
		memory: { recall: false, ...opts.memory },
	})
	opened.push(session)
	for await (const _event of session.send([createUserMessage('hello')], {
		permissionMode: 'auto',
	})) {
		// Consume the turn.
	}
	const request = provider.requests[0]
	return {
		session,
		offered: request?.tools?.map((tool) => tool.function.name) ?? [],
		system:
			request?.messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n')
				.replaceAll(cwd, '<cwd>') ?? '',
	}
}

describe('past-conversation search in the session', () => {
	it('is on by default and sends its full schema only when tools are not deferred', async () => {
		const eager = await run({ toolLoading: 'eager' })
		expect(eager.session.toolNames()).toContain(PAST_CONVERSATION_SEARCH_TOOL)
		expect(eager.offered).toContain(PAST_CONVERSATION_SEARCH_TOOL)
		const deferred = await run({ toolLoading: 'deferred' })
		expect(deferred.session.toolNames()).toContain(PAST_CONVERSATION_SEARCH_TOOL)
		expect(deferred.offered).not.toContain(PAST_CONVERSATION_SEARCH_TOOL)
		expect(deferred.system).toContain(PAST_CONVERSATION_SEARCH_TOOL)
	})

	it('off leaves the tool list and the prompt exactly as they were without the tool', async () => {
		for (const toolLoading of ['eager', 'deferred'] as const) {
			const on = await run({ toolLoading })
			const off = await run({ toolLoading, memory: { searchPastConversations: false } })
			expect(off.session.toolNames()).not.toContain(PAST_CONVERSATION_SEARCH_TOOL)
			expect(off.offered).not.toContain(PAST_CONVERSATION_SEARCH_TOOL)
			expect(off.system).not.toContain(PAST_CONVERSATION_SEARCH_TOOL)
			// On differs from off by that one tool and nothing else in the tool list.
			expect(on.offered.filter((name) => name !== PAST_CONVERSATION_SEARCH_TOOL)).toEqual(
				off.offered,
			)
			// The prompt differs only by the one deferred-tool line, and only when tools are deferred.
			const stripped = on.system
				.split('\n')
				.filter((line) => !line.includes(PAST_CONVERSATION_SEARCH_TOOL))
				.join('\n')
			expect(stripped).toBe(off.system)
		}
	})

	it('is not mounted without host-owned conversation storage', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-past-search-none-'))
		roots.push(cwd)
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const session = await createAgentSession(preferences, detected, {
			toolLoading: 'eager',
			cwd,
			sandbox: { enabled: false },
			ephemeral: true,
		})
		opened.push(session)
		expect(session.toolNames()).not.toContain(PAST_CONVERSATION_SEARCH_TOOL)
	})
})
