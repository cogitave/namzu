/**
 * Esc and /config through the real App, where the newer surfaces meet:
 * Esc inside the detailed transcript only closes it (the draft keeps its text
 * and no clear window opens, and a running reply is not interrupted), Esc on a
 * running reply interrupts it, and the /config picker holds a row for every
 * setting the terminal has.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

/** When set, the reply waits here until the test lets it go or interrupts it. */
let hold: Promise<void> | undefined
let sawAbort = false

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
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
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: 'first words\n\n' } as AgentEvent
				if (hold) {
					opts?.signal?.addEventListener('abort', () => {
						sawAbort = true
					})
					await hold
				}
				if (opts?.signal?.aborted) return
				yield { kind: 'delta', text: 'late words' } as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []
const ESC = '\x1b'
const CTRL_O = '\x0f'

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	hold = undefined
	sawAbort = false
	vi.restoreAllMocks()
})

async function open() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('a-model'))
	return harness
}

async function send(harness: Awaited<ReturnType<typeof open>>, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
}

describe('Esc', () => {
	it('only closes the detailed transcript: the draft stays and no clear window opens', async () => {
		const harness = await open()
		await send(harness, 'go')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('late words'))
		harness.stdin.write('half-typed')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('half-typed'))
		harness.stdin.write(CTRL_O)
		await vi.waitFor(() =>
			expect(harness.lastFrame() ?? '').toContain('Showing detailed transcript'),
		)

		harness.stdin.write(ESC)
		await vi.waitFor(() =>
			expect(harness.lastFrame() ?? '').not.toContain('Showing detailed transcript'),
		)
		await tick()
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('half-typed')
		expect(frame).not.toContain('Esc again to clear')
	})

	it('does not interrupt a running reply when it only closes the detailed transcript', async () => {
		let release!: () => void
		hold = new Promise<void>((resolve) => {
			release = resolve
		})
		const harness = await open()
		await send(harness, 'go')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('first words'))
		harness.stdin.write(CTRL_O)
		await vi.waitFor(() =>
			expect(harness.lastFrame() ?? '').toContain('Showing detailed transcript'),
		)
		harness.stdin.write(ESC)
		await vi.waitFor(() =>
			expect(harness.lastFrame() ?? '').not.toContain('Showing detailed transcript'),
		)
		await tick()
		expect(sawAbort).toBe(false)
		release()
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('late words'))
	})

	it('interrupts a running reply from the composer', async () => {
		hold = new Promise<void>(() => {})
		const harness = await open()
		await send(harness, 'go')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('first words'))
		harness.stdin.write(ESC)
		await vi.waitFor(() => expect(sawAbort).toBe(true))
		await vi.waitFor(() => expect(harness.frames.join('\n')).toContain('Interrupted'))
	})
})

describe('/config', () => {
	it('holds a row for every terminal setting', async () => {
		const harness = await open()
		await send(harness, '/config')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Configuration'))
		for (let i = 0; i < 16; i += 1) {
			harness.stdin.write('\x1b[B')
			await tick(10)
		}
		const seen = harness.frames.join('\n')
		for (const label of [
			'Theme',
			'Reduce motion',
			'Session recap',
			'Tips',
			'Composer triggers',
			'Setting sources',
		]) {
			expect(seen, `no ${label} row`).toContain(label)
		}
	})
})
