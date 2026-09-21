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
	CONVERSATION_EVIDENCE_GUIDANCE,
	CONVERSATION_RETRIEVAL_TOOLS,
} from '../../integrations/sessions/conversation-search.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * Conversation search reads the session's own log, so the CLI offers it only
 * when the host owns that log. The search and read behaviour itself is covered
 * against a real log in `integrations/sessions/__tests__/conversation-search.test.ts`;
 * this is the seam where the tools join, or stay out of, the session's roster.
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

async function send(session: AgentSession): Promise<void> {
	for await (const _event of session.send([createUserMessage('Anything earlier?')], {
		permissionMode: 'auto',
	})) {
		// Consume the production adapter and kernel.
	}
}

function systemText(provider: MockLLMProvider): string {
	return (
		provider.requests[0]?.messages
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n') ?? ''
	)
}

it('does not offer conversation search without host-owned conversation storage', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-evidence-unmounted-'))
	roots.push(cwd)
	const provider = new MockLLMProvider({ turns: [{ text: 'No historical search configured.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		ephemeral: true,
	})
	opened.push(session)
	for (const tool of CONVERSATION_RETRIEVAL_TOOLS) expect(session.toolNames()).not.toContain(tool)
	await send(session)
	expect(
		provider.requests[0]?.tools?.some((tool) =>
			(CONVERSATION_RETRIEVAL_TOOLS as readonly string[]).includes(tool.function.name),
		),
	).toBe(false)
	expect(systemText(provider)).not.toContain(CONVERSATION_EVIDENCE_GUIDANCE)
})

it('offers conversation search over the session log the host owns', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-evidence-mounted-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const provider = new MockLLMProvider({ turns: [{ text: 'Searched.' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
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
	})
	opened.push(session)
	for (const tool of CONVERSATION_RETRIEVAL_TOOLS) expect(session.toolNames()).toContain(tool)
	await send(session)
	const offered = provider.requests[0]?.tools?.map((tool) => tool.function.name) ?? []
	for (const tool of CONVERSATION_RETRIEVAL_TOOLS) expect(offered).toContain(tool)
	expect(systemText(provider)).toContain(CONVERSATION_EVIDENCE_GUIDANCE)
})
