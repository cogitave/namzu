/**
 * `/doctor` through the production App: the checks run once, the rows are
 * plain, and the complete report sits behind the row's details.
 */

import type { Message } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const doctorState = vi.hoisted(() => ({ runs: 0 }))
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => '91d5cf2f-12e5-4cee-a622-e9d3cc9b17f0',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	loadConversation: async () => [],
	loadResumableConversation: async () => [],
	listRecent: async () => [],
}))
vi.mock('../../doctor/live.js', () => ({
	runLiveDoctor: async () => {
		doctorState.runs += 1
		return {
			version: '1.0.0',
			timestamp: '2026-10-27T00:00:00Z',
			checks: [
				{ id: 'sandbox.platform', category: 'sandbox', status: 'pass', durationMs: 3 },
				{
					id: 'scheduler.service',
					category: 'runtime',
					status: 'warn',
					message: 'The scheduler is not running.',
					remediation: 'Start it with the schedule command.',
					durationMs: 4,
				},
			],
			summary: { pass: 1, fail: 0, warn: 1, inconclusive: 0, skipped: 0, total: 2 },
			exit: 0,
		}
	},
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'OpenAI (Codex subscription)',
			modelSummary: 'gpt-test',
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
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by rename prompt')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (_messages: readonly Message[]): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	doctorState.runs = 0
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 100): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		// A lone Escape is intentionally held briefly by Ink's terminal parser so
		// it can distinguish it from the prefix of an arrow/function-key sequence.
		await new Promise((resolve) => setTimeout(resolve, 20))
		await screen.waitForRender()
	}
	expect(predicate(), screen.viewport().join('\n')).toBe(true)
}

it('runs the checks and says what needs attention in plain words', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('gpt-test'))
	screen.press('/doctor')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('1 check needs attention.'))
	const output = screen.scrollback().join('\n')
	expect(output).toContain('✓ Sandbox')
	expect(output).toContain(
		'! Scheduled tasks: scheduled tasks will not run until the scheduler is set up',
	)
	expect(output).toContain('Try: Run "namzu schedule install".')
	expect(output).not.toContain('scheduler.service')
	expect(output).not.toContain('Checking…')
	expect(output).not.toMatch(/\dms/)
	expect(doctorState.runs).toBe(1)
})
