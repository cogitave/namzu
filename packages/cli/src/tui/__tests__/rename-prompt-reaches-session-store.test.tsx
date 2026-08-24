/**
 * `/rename` is a host text decision, not a model prompt with special spelling.
 *
 * The observer drives the production App and terminal renderer: the current
 * durable name must reach the editor, a deliberate edit must reach setTitle,
 * and `/resume` must read the resulting name back. A parser-only test would
 * stay green if App went back to printing usage instead of opening anything.
 */

import type { Message } from '@namzu/sdk'
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

const titleState = vi.hoisted(() => ({
	current: 'Current project title' as string | undefined,
	writes: [] as string[],
}))
const turnState = vi.hoisted(() => {
	let releaseFirst = () => {}
	let firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})
	return {
		calls: 0,
		gate: () => firstGate,
		release: () => releaseFirst(),
		reset: () => {
			releaseFirst()
			firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
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
	startConversation: async () => 'ses_rename',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	loadConversation: async () => [],
	loadResumableConversation: async () => [],
	titleOf: () => titleState.current,
	setTitle: (_sessions: unknown, _sessionId: string, title: string) => {
		titleState.current = title.trim() || undefined
		titleState.writes.push(title)
	},
	listRecent: async () => [
		{
			id: 'ses_previous',
			title: titleState.current ?? 'Opening prompt',
			updatedAt: new Date().toISOString(),
			count: 2,
			named: titleState.current !== undefined,
		},
	],
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
				throw new Error('not used by rename prompt')
			},
			close: async () => {},
			send: async function* (_messages: readonly Message[]): AsyncIterable<AgentEvent> {
				turnState.calls += 1
				if (turnState.calls === 1) {
					yield { kind: 'delta', text: 'first turn is working\n\n' } as AgentEvent
					await turnState.gate()
				}
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	turnState.release()
	await mounted?.unmount()
	mounted = null
	titleState.current = 'Current project title'
	titleState.writes.length = 0
	turnState.calls = 0
	turnState.reset()
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

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

it('prefills, edits, persists, and exposes the conversation name to /resume', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 24,
	})
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	screen.press('/rename')
	await screen.waitForRender()
	screen.press('\r')
	// The same key repeated before the new owner paints is not a deliberate save.
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Rename conversation'))

	let output = painted(screen)
	expect(output).toContain('Current project title')
	expect(output).toContain('enter save · esc cancel')
	expect(titleState.writes).toEqual([])

	// Edit the prefilled value using the same Ctrl+W vocabulary as the main
	// composer, then make one explicit durable submission.
	screen.press('\x17')
	screen.press('roadmap')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Named "Current project roadmap".'))
	expect(titleState.writes).toEqual(['Current project roadmap'])

	screen.press('/resume')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Resume a conversation'))
	output = painted(screen)
	expect(output).toContain('"Current project roadmap"')
})

it('cancels without mutating the durable name', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 100,
		rows: 20,
	})
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	screen.press('/title')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Rename conversation'))
	screen.press('\x15')
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('cannot be empty'))
	expect(titleState.writes).toEqual([])
	screen.press('Discard me')
	screen.press('\x1b')
	await waitUntil(screen, () => painted(screen).includes('Type a message'))

	expect(titleState.current).toBe('Current project title')
	expect(titleState.writes).toEqual([])
})

it('holds an already queued turn until the name editor closes', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 22 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	screen.press('start work')
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('first turn is working'))
	screen.press('queued after rename')
	screen.press('\t')
	await waitUntil(screen, () => painted(screen).includes('1 message queued'))
	screen.press('/rename')
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Rename conversation'))

	turnState.release()
	for (let index = 0; index < 5; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20))
		await screen.waitForRender()
	}
	expect(turnState.calls).toBe(1)

	screen.press('\x1b')
	await waitUntil(screen, () => turnState.calls === 2)
})

it('uses Ctrl+C to cancel the editor without arming App exit', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 20 })
	mounted = screen
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	screen.press('/rename')
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Rename conversation'))
	screen.press('\x03')
	await waitUntil(screen, () => painted(screen).includes('Type a message'))

	expect(painted(screen)).not.toContain('Press Ctrl+C again to exit.')
})
