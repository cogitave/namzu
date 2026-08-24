/** A shell-resumed conversation must become both the visible and model history. */

import type { Message } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import { renderToScreen } from './support/screen.js'

const existing: readonly Message[] = [
	{ role: 'user', content: 'remember the blue door', timestamp: 1 },
	{ role: 'assistant', content: 'I will remember it.', timestamp: 2 },
]
const sent: Message[][] = []
const startConversation = vi.hoisted(() => vi.fn(async () => 'ses_fresh'))
const loadResumableConversation = vi.hoisted(() => vi.fn())
const probeAgentSessionCall = vi.hoisted(() => vi.fn())
const createAgentSessionCall = vi.hoisted(() => vi.fn())

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: 'prj_test',
		topicId: 'top_test',
		turnEvidence: {
			recordTurnStarted: async (input: unknown) => ({
				...(input as object),
				turnId: 'turn_1',
			}),
			recordTurnSettled: async (input: unknown) => input,
		},
	}),
	startConversation,
	loadResumableConversation,
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'openai' }],
		subagents: { active: [] },
	}
	return {
		...actual,
		probeAgentSession: async () => {
			probeAgentSessionCall()
			return {
				preferences,
				needsRepickReason: null,
				credentialGap: null,
				detected: [],
			}
		},
		createAgentSession: async (): Promise<AgentSession> => {
			createAgentSessionCall()
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'provider',
				modelSummary: 'model',
				reasoningEffortLevels: [],
				toolNames: () => [],
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				resumeDurable: async () => {
					throw new Error('not used')
				},
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (messages): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}
		},
	}
})

const { App } = await import('../App.js')

async function waitUntil(
	screen: Awaited<ReturnType<typeof renderToScreen>>,
	predicate: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	throw new Error(message)
}

afterEach(() => {
	sent.length = 0
	startConversation.mockClear()
	loadResumableConversation.mockClear()
	probeAgentSessionCall.mockClear()
	createAgentSessionCall.mockClear()
	vi.restoreAllMocks()
})

describe('the shell resume handoff inside App', () => {
	it('loads the exact conversation without minting a fresh id and sends its history', async () => {
		loadResumableConversation.mockResolvedValue(existing)
		const screen = await renderToScreen(
			<App
				ctx={{
					cwd: '/workspace',
					version: '0.0.0-test',
					initialConversationId: 'ses_existing',
				}}
			/>,
			{ cols: 100, rows: 24 },
		)
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Connected to provider')),
				'App never became ready',
			)
			expect(loadResumableConversation).toHaveBeenCalledWith(expect.anything(), 'ses_existing')
			expect(startConversation).not.toHaveBeenCalled()
			expect(screen.scrollback().join('\n')).toContain('remember the blue door')

			screen.press('continue from there')
			await screen.waitForRender()
			screen.press('\r')
			await waitUntil(screen, () => sent.length === 1, 'resumed turn never reached the session')

			expect(sent[0]?.map((message) => [message.role, message.content])).toEqual([
				['user', 'remember the blue door'],
				['assistant', 'I will remember it.'],
				['user', 'continue from there'],
			])
		} finally {
			await screen.unmount()
		}
	})

	it('refuses a missing exact conversation before provider discovery or construction', async () => {
		loadResumableConversation.mockRejectedValue(new Error('conversation was not found'))
		const screen = await renderToScreen(
			<App
				ctx={{
					cwd: '/workspace',
					version: '0.0.0-test',
					initialConversationId: 'ses_missing',
				}}
			/>,
			{ cols: 100, rows: 24 },
		)
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Could not resume ses_missing')),
				'exact resume refusal never reached the terminal',
			)
			expect(startConversation).not.toHaveBeenCalled()
			expect(probeAgentSessionCall).not.toHaveBeenCalled()
			expect(createAgentSessionCall).not.toHaveBeenCalled()
		} finally {
			await screen.unmount()
		}
	})
})
