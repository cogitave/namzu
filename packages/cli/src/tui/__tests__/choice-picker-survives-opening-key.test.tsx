/**
 * A slash-command chooser must survive the key that opens it.
 *
 * Composer and App both receive the production Ink input event. Composer may
 * publish a picker synchronously while handling Return; that same Return is
 * not a deliberate choice from a menu the terminal has not painted yet.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const feedback = vi.hoisted(() => ({ writes: [] as Record<string, unknown>[] }))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		DiskMessageFeedbackStore: class {
			async listMessageFeedback() {
				return []
			}

			async putMessageFeedback(input: Record<string, unknown>) {
				feedback.writes.push(input)
				return { ...input, ownerVersion: 1 }
			}
		},
	}
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
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
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			approvalLatched: () => false,
			resetApprovalLatch: () => {},
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the picker test')
			},
			close: async () => {},
			send: async function* () {
				yield {
					kind: 'delta',
					text: 'A completed answer with an exact feedback identity.',
					runId: 'run_feedback',
					messageId: 'msg_feedback',
				} as AgentEvent
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
	feedback.writes.length = 0
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 80): Promise<void> {
	for (let i = 0; i < attempts && !predicate(); i++) await screen.waitForRender()
	expect(predicate()).toBe(true)
}

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

it('paints /permissions choices before a later key can select one', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 28,
	})
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	for (const key of ['/', 'p', 'e', 'r']) {
		screen.press(key)
		await screen.waitForRender()
	}
	await waitUntil(screen, () => painted(screen).includes('/permissions'))

	// This Return belongs to Composer/autocomplete. It opens the chooser; it
	// must not also select the current first row before the chooser is painted.
	screen.press('\r')
	// A terminal/key-repeat can deliver another Return before Ink commits the
	// pending chooser. It has the same ownership as the opening Return: there is
	// still no painted menu for it to accept.
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Select Permission Mode'))
	let output = painted(screen)
	expect(output).not.toContain('Permission mode changed to prompt')

	// A later key, sent after the menu is visible, does own a choice.
	screen.press('3')
	await waitUntil(screen, () => painted(screen).includes('Permission mode changed to strict'))
	output = painted(screen)
	expect(output.match(/Permission mode changed to strict/g)).toHaveLength(1)
})

it('opens bare /feedback as a finite chooser for the completed answer', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 28,
	})
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	screen.press('answer me')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('exact feedback identity'))

	screen.press('/feedback')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Rate the latest answer'))

	const output = screen.viewport().join('\n')
	expect(output).toContain('good')
	expect(output).toContain('The answer was useful and correct.')
	expect(output).toContain('bad')
	expect(output).toContain('The answer needs improvement.')

	screen.press('\r')
	await waitUntil(screen, () => feedback.writes.length === 1)
	expect(feedback.writes).toEqual([
		expect.objectContaining({
			runId: 'run_feedback',
			messageId: 'msg_feedback',
			rating: 'good',
		}),
	])
})
