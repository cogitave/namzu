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
const startConversation = vi.hoisted(() => vi.fn(async () => '0ac90d46-4041-4402-8bc7-89c9a8c75f73'))
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
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
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
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
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
					initialConversationId: 'b74ac146-4b6d-45b8-b04b-e019792facf9',
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
			expect(loadResumableConversation).toHaveBeenCalledWith(expect.anything(), 'b74ac146-4b6d-45b8-b04b-e019792facf9')
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

	it('hydrates Ctrl+R from authored prompts without exposing runtime context as input history', async () => {
		loadResumableConversation.mockResolvedValue([
			...existing,
			{
				role: 'user',
				content: 'automatic continuation that was not typed',
				timestamp: 3,
				source: { type: 'runtime-context', kind: 'auto-continuation' },
			},
		])
		const screen = await renderToScreen(
			<App
				ctx={{
					cwd: '/workspace',
					version: '0.0.0-test',
					initialConversationId: 'b74ac146-4b6d-45b8-b04b-e019792facf9',
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
			screen.press('\x12')
			screen.press('\r')
			await waitUntil(screen, () => sent.length === 1, 'recalled resumed prompt never ran')

			expect(sent[0]?.at(-1)).toMatchObject({
				role: 'user',
				content: 'remember the blue door',
			})
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
					initialConversationId: '1ef9ce34-f888-4928-9659-b4f6388670a9',
				}}
			/>,
			{ cols: 100, rows: 24 },
		)
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Could not resume 1ef9ce34-f888-4928-9659-b4f6388670a9')),
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
