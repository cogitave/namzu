import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * `session_cost` reads the session's own log, so the CLI offers it only when
 * the host owns that log, and a model that calls it gets the figures a real
 * turn recorded rather than a refusal.
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
	providers: [{ id: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.openrouter,
		source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

async function send(session: AgentSession, prompt: string): Promise<void> {
	for await (const _event of session.send([createUserMessage(prompt)], {
		permissionMode: 'auto',
	})) {
		// Consume the production adapter and kernel.
	}
}

async function open(provider: MockLLMProvider, hosted: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-session-cost-seam-'))
	roots.push(cwd)
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	if (!hosted) {
		const bare = await createAgentSession(preferences, detected, {
			cwd,
			sandbox: { enabled: false },
			ephemeral: true,
		})
		opened.push(bare)
		return bare
	}
	const sessions = await openSessions(cwd, {
		stateRoot: await mkdtemp(join(tmpdir(), 'namzu-session-cost-seam-home-')),
	})
	roots.push(sessions.root)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const session = await createAgentSession(preferences, detected, {
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
		memory: { recall: false },
		toolLoading: 'eager',
		// Automatic recall makes its own request before the turn; this is the model's own call.
		compaction: { recallEvidence: false },
	})
	opened.push(session)
	return session
}

/** Usage with the charge the provider reports, which the ledger takes as the call's cost. */
const usage = (promptTokens: number, completionTokens: number, reportedCostUsd: number) => ({
	promptTokens,
	completionTokens,
	totalTokens: promptTokens + completionTokens,
	reportedCostUsd,
})

async function askCost(hosted: boolean): Promise<string> {
	const provider = new MockLLMProvider({
		turns: [
			{ text: 'Hello.', usage: usage(1000, 100, 0.004) },
			{
				toolCalls: [{ id: 'cost-1', name: 'session_cost', args: {} }],
				usage: usage(1200, 50, 0.003),
			},
			{ text: 'Done.', usage: usage(1300, 20, 0.002) },
		],
	})
	const session = await open(provider, hosted)
	expect(session.toolNames()).toContain('session_cost')

	await send(session, 'Say hello.')
	await send(session, 'What has this conversation cost so far?')

	const offered = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? []
	expect(offered).toContain('session_cost')
	const result = provider.requests
		.flatMap((request) => request.messages)
		.find((message) => message.role === 'tool' && message.toolCallId === 'cost-1')
	expect(result).toBeDefined()
	// One request per call the script holds: the first turn, then the call that
	// asks for the cost and the one that reads the answer. No side request.
	expect(provider.requests).toHaveLength(3)
	return String(result?.content)
}

it('offers session_cost and answers it from the log the turns wrote', async () => {
	const output = await askCost(true)
	// The first call and the call that asked, as the turn recorder stamped them.
	expect(output).toContain('This conversation so far: $0.0070.')
	expect(output).toContain('not counted yet')
})

it('offers session_cost in a run that keeps no log on disk, and answers it from the transient log', async () => {
	const output = await askCost(false)
	expect(output).toContain('This conversation so far: $0.0070.')
	expect(output).toContain('not counted yet')
})
