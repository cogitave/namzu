import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	MockLLMProvider,
	type MockTurn,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { CONVERSATION_EVIDENCE_GUIDANCE } from '../../integrations/sessions/conversation-search.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * A follow-up that asks why the model said something it said a turn ago. Nothing
 * has been compacted, so everything is in view: the request must carry no pointer
 * to the history tools, and must frame the model's own earlier message as what it
 * said, to be quoted, not as an unproven claim to re-check. The fake provider
 * answers each kind of request in its own way: the history-lookup request (no
 * tools) gets a lookup plan, the model's requests get prose.
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

const FIRST_ANSWER =
	'Budgets/ is not part of the import: the README says no code reads it, and it belongs to the finance team.'

function textOf(content: unknown): string {
	return typeof content === 'string' ? content : JSON.stringify(content)
}

/** Everything the model was shown in one request, apart from the system prompt. */
function conversationText(request: ChatCompletionParams): string {
	return request.messages
		.filter((message) => message.role !== 'system')
		.map((message) => textOf(message.content))
		.join('\n')
}

async function send(session: AgentSession, prompt: string): Promise<void> {
	for await (const _event of session.send([createUserMessage(prompt)], {
		permissionMode: 'auto',
	})) {
		// Consume the production adapter and kernel.
	}
}

it('shows no history-search pointer before compaction, and frames its own message as what it said', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-own-message-'))
	roots.push(cwd)
	const stateRoot = await mkdtemp(join(tmpdir(), 'namzu-own-message-home-'))
	roots.push(stateRoot)
	const sessions = await openSessions(cwd, { stateRoot })
	roots.push(sessions.root)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const provider = new MockLLMProvider({
		nextTurn: (params): MockTurn => {
			// The kernel's own small request carries no tools: it gets a plan, not prose.
			if (!params.tools?.length)
				return {
					text: '{"mode":"direct","time":"unspecified","termIds":[],"focusIds":[],"basis":[]}',
				}
			const sawQuestion = params.messages.some((m) =>
				textOf(m.content).includes('Why did you mention'),
			)
			return {
				text: sawQuestion
					? 'I mentioned Budgets/ because the README says no code reads it, and it belongs to the finance team.'
					: FIRST_ANSWER,
			}
		},
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		toolLoading: 'eager',
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

	await send(session, 'What should I ignore in this repo?')
	await send(session, 'Why did you mention Budgets?')

	const modelRequests = provider.requests.filter((request) => request.tools?.length)
	// The follow-up points at the model's own last reply, so no history-lookup request was made.
	expect(provider.requests.filter((request) => !request.tools?.length)).toEqual([])
	const followUp = modelRequests.at(-1)
	if (!followUp) throw new Error('the follow-up never reached the model')
	const shown = conversationText(followUp)
	expect(shown).toContain('Why did you mention Budgets?')
	expect(shown).toContain(FIRST_ANSWER)

	// Nothing was shed, so nothing in the conversation points at the history tools.
	expect(shown).not.toContain('Context inventory')
	expect(shown).not.toContain('"continuations"')
	expect(shown).not.toContain('"additionalEvidence"')
	expect(shown).not.toContain('conversation-history tools')
	expect(shown).not.toContain('use search_conversation')

	// The one rule is stated, in the system prompt and in whatever evidence block was added.
	const system = followUp.messages
		.filter((message) => message.role === 'system')
		.map((message) => textOf(message.content))
		.join('\n')
	expect(system).toContain(CONVERSATION_EVIDENCE_GUIDANCE)
	expect(system).toContain(
		'A question about your own earlier answer is answered from that answer; do not open files to find a reason you did not have.',
	)
	if (shown.includes('Retrieved conversation evidence')) {
		expect(shown).toContain(
			'If the answer is in your own earlier messages or tool results that are visible now, answer from them; do not search.',
		)
		expect(shown).not.toContain('is a prior model claim')
		expect(shown).toContain('quote it and answer from it')
	}
})
