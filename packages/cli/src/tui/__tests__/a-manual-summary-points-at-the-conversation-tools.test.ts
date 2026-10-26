import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	COMPACTION_RECOVERY_NOTE,
	MockLLMProvider,
	ProviderRegistry,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
 * A summary written between turns names the conversation tools only while the
 * session mounts them, for the whole-history and the selected-range passes alike.
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

const history = () => [
	createUserMessage('first question'),
	createAssistantMessage('first answer'),
	createUserMessage('second question'),
	createAssistantMessage('second answer'),
	createUserMessage('third question'),
	createAssistantMessage('third answer'),
	createUserMessage('fourth question'),
	createAssistantMessage('fourth answer'),
]

async function open(withConversationTools: boolean): Promise<AgentSession> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-manual-note-'))
	roots.push(cwd)
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({
		provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
	} as never)
	if (!withConversationTools) {
		const session = await createAgentSession(preferences, detected, {
			cwd,
			sandbox: { enabled: false },
			ephemeral: true,
		})
		opened.push(session)
		return session
	}
	const sessions = await openSessions(cwd)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		ephemeral: true,
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
	return session
}

describe('the pointer at the end of a manual summary', () => {
	it('is added when the session mounts the conversation tools', async () => {
		const session = await open(true)
		const whole = await session.compact(history())
		expect(String(whole?.summary.content)).toContain(COMPACTION_RECOVERY_NOTE)

		const messages = history()
		const range = await session.compactRange?.({
			messages,
			from: messages[0],
			until: messages[4],
		})
		expect(String(range?.summary.content)).toContain(COMPACTION_RECOVERY_NOTE)
	})

	it('is left out when the session does not mount them', async () => {
		const session = await open(false)
		const whole = await session.compact(history())
		expect(String(whole?.summary.content)).not.toContain('search_conversation')

		const messages = history()
		const range = await session.compactRange?.({
			messages,
			from: messages[0],
			until: messages[4],
		})
		expect(range).toBeTruthy()
		expect(String(range?.summary.content)).not.toContain('search_conversation')
	})
})
