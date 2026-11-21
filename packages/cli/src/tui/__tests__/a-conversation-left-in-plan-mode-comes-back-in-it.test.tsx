/**
 * A conversation continued with `-c` comes back in plan mode when it was left in plan mode, and
 * in the usual mode otherwise. A launch that names a mode keeps the one it named.
 */

import type { Message, SessionRecord } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { rememberJournal } from '../../integrations/sessions/journal-trail.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import { renderToScreen } from './support/screen.js'

const existing: readonly Message[] = [
	{ role: 'user', content: 'plan the migration', timestamp: 1 },
	{ role: 'assistant', content: 'Here is the plan.', timestamp: 2 },
]
const saved = vi.hoisted(() => ({ mode: undefined as string | undefined }))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
	}),
	startConversation: async () => '0ac90d46-4041-4402-8bc7-89c9a8c75f73',
	loadResumableConversation: async () => {
		const messages = [...existing]
		const records =
			saved.mode === undefined
				? []
				: ([{ type: 'session_updated', approvalPolicy: saved.mode }] as unknown as SessionRecord[])
		rememberJournal(messages, records)
		return messages
	},
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
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
		probeAgentSession: async () => ({
			preferences,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'provider',
			modelSummary: 'a-model',
			reasoningEffortLevels: [],
			toolNames: () => [],
			presenter: genericPresenter,
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
				throw new Error('not used')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')

afterEach(() => {
	saved.mode = undefined
})

async function resumed(
	mode: string | undefined,
	launch?: { permissionMode: 'prompt' },
): Promise<string> {
	saved.mode = mode
	const screen = await renderToScreen(
		<App
			ctx={{
				cwd: '/workspace',
				version: '0.0.0-test',
				initialConversationId: 'b74ac146-4b6d-45b8-b04b-e019792facf9',
				...(launch ? { launchSettings: launch as never } : {}),
			}}
		/>,
		{ cols: 100, rows: 24 },
	)
	try {
		for (let i = 0; i < 100; i += 1) {
			await screen.waitForRender()
			if (screen.scrollback().some((line) => line.includes('Resumed'))) break
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
		await screen.waitForRender()
		return screen.viewport().join('\n')
	} finally {
		await screen.unmount()
	}
}

describe('continuing a conversation', () => {
	it('is in plan mode when it was left in plan mode', async () => {
		expect(await resumed('plan')).toContain('plan mode on')
	})

	it('is in the usual mode when nothing was saved or plan mode was left', async () => {
		expect(await resumed(undefined)).not.toContain('plan mode on')
		expect(await resumed('prompt')).not.toContain('plan mode on')
	})

	it('keeps the mode the launch named', async () => {
		expect(await resumed('plan', { permissionMode: 'prompt' })).not.toContain('plan mode on')
	})
})
