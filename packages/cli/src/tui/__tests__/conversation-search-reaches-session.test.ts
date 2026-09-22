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
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
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
 * when the host owns that log. The adapter's own rules are covered against a
 * stand-in reader in `integrations/sessions/conversation-search.test.ts` and
 * `conversation-evidence-boundaries.test.ts`; this is the seam where the tools
 * join, or stay out of, the session's roster, and where they read the log a
 * real turn wrote through the SDK's own reader.
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

async function send(session: AgentSession, prompt = 'Anything earlier?'): Promise<void> {
	for await (const _event of session.send([createUserMessage(prompt)], {
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

it('finds and reads an earlier answer in the session log a real turn wrote', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-evidence-real-log-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd, {
		stateRoot: await mkdtemp(join(tmpdir(), 'namzu-evidence-real-log-home-')),
	})
	roots.push(sessions.root)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const provider = new MockLLMProvider({
		turns: [
			{ text: 'The receipt number is ORCHID-4417.' },
			{
				toolCalls: [
					{ id: 'search-1', name: 'search_conversation', args: { query: 'orchid-4417' } },
				],
			},
			{ text: 'It was ORCHID-4417.' },
		],
	})
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
		// Automatic recall would answer before the model asks; this is the model's own search.
		compaction: { recallEvidence: false },
	})
	opened.push(session)

	await send(session, 'What is the receipt number?')
	await send(session, 'What was that receipt number again?')

	// The model's own search, inside the second turn, found the first turn's answer.
	const toolResult = provider.requests
		.flatMap((request) => request.messages)
		.find((message) => message.role === 'tool' && message.toolCallId === 'search-1')
	expect(toolResult).toBeDefined()
	const answered = JSON.parse(String(toolResult?.content)) as {
		matches: { seq: number; part: number; text: string; recordKind: string }[]
	}
	expect(answered.matches).toContainEqual(
		expect.objectContaining({
			text: 'The receipt number is ORCHID-4417.',
			recordKind: 'assistant_message',
		}),
	)

	// After the turns settle, the log itself answers, and a cold read returns the exact text.
	const found = await searchConversation(sessions, sessionId, { query: 'ORCHID-4417' })
	const match = found.matches.find((candidate) => candidate.text.includes('receipt number is'))
	if (!match) throw new Error('the settled log did not contain the first answer')
	await releaseConversationEvidence(sessions, sessionId)
	const exact = await readConversationEvidence(sessions, sessionId, {
		seq: match.seq,
		part: match.part,
	})
	expect(exact).toMatchObject({ text: 'The receipt number is ORCHID-4417.', complete: true })
	expect(found.incomplete).toBe(false)
})
