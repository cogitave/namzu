/** Ctrl+O opens the detailed transcript through the App and closes it again. */

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

/** Twelve lines: six show before the fold, so line 9 only exists on the screen. */
const BODY = Array.from({ length: 12 }, (_, i) => `body-line-${i + 1}`)

/** Held open by a test that needs the turn to be mid-stream. */
let release: (() => void) | undefined
/** When set, the turn waits for this gate and then asks to run a command. */
let permissionGate: Promise<void> | undefined
/** What the fake session was told about the command it asked to run. */
const decisions: unknown[] = []

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
			toolNames: () => ['bash'],
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
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'reasoning', text: 'weighing-the-options' } as AgentEvent
				yield { kind: 'reasoning', text: '', done: true } as AgentEvent
				yield { kind: 'delta', text: 'The plan is ready.\n\n' } as AgentEvent
				yield {
					kind: 'tool-start',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ls',
					detail: BODY,
				} as AgentEvent
				yield {
					kind: 'tool-end',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ok',
					isError: false,
					detail: BODY,
				} as AgentEvent
				if (permissionGate !== undefined) {
					await permissionGate
					const decision = await opts?.onPermission?.({
						toolCalls: [
							{
								id: 'call-1',
								name: 'bash',
								input: { command: 'rm -rf build' },
								isDestructive: true,
							},
						],
					} as never)
					decisions.push(decision)
				}
				if (release !== undefined) {
					await new Promise<void>((resolve) => {
						const done = release
						release = () => {
							done?.()
							resolve()
						}
					})
					yield { kind: 'delta', text: 'late-words-arrived' } as AgentEvent
				}
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []
const CTRL_O = '\x0f'
const CTRL_E = '\x05'
const CTRL_C = '\x03'

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	release = undefined
	permissionGate = undefined
	decisions.length = 0
	vi.restoreAllMocks()
})

async function frameShows(lastFrame: () => string | undefined, text: string): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').toContain(text))
}
async function frameLacks(lastFrame: () => string | undefined, text: string): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').not.toContain(text))
}

async function afterATurn() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'a-model')
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'body-line-12')
	return harness
}

describe('the detailed transcript', () => {
	it('shows every line and the thinking, with no hint and no composer', async () => {
		const { stdin, lastFrame } = await afterATurn()
		expect(lastFrame() ?? '', 'the fold should hide line 9 in the live view').not.toContain(
			'body-line-9',
		)

		stdin.write(CTRL_O)
		await frameShows(lastFrame, 'Showing detailed transcript')

		const frame = lastFrame() ?? ''
		expect(frame).toContain('body-line-9')
		expect(frame).toContain('body-line-12')
		expect(frame).toContain('ctrl+o to toggle')
		expect(frame).toContain('ctrl+e to show all')
		expect(frame).toContain('verbose')
		expect(frame, 'a hint points at the screen it is on').not.toContain('(ctrl+o to expand)')
		// The window is as tall as the terminal; `g` goes to its first row, where
		// the thinking is drawn above the reply it led to.
		stdin.write('g')
		await frameShows(lastFrame, 'weighing-the-options')
		expect(lastFrame() ?? '').toContain('∵')
		stdin.write('G')
		await frameShows(lastFrame, 'body-line-12')
	})

	it('draws the thinking nowhere else', async () => {
		const { lastFrame } = await afterATurn()
		expect(lastFrame() ?? '').not.toContain('weighing-the-options')
	})

	it.each([
		['Ctrl+O', CTRL_O],
		['Esc', '\x1b'],
		['q', 'q'],
		['Ctrl+C', CTRL_C],
	])('%s returns to the composer with the draft intact', async (_name, key) => {
		const { stdin, lastFrame } = await afterATurn()
		stdin.write('half-typed')
		await frameShows(lastFrame, 'half-typed')

		stdin.write(CTRL_O)
		await frameShows(lastFrame, 'Showing detailed transcript')
		expect(lastFrame() ?? '').not.toContain('half-typed')

		stdin.write(key)
		await frameLacks(lastFrame, 'Showing detailed transcript')
		await frameShows(lastFrame, 'half-typed')
	})

	it('does not arm the exit on Ctrl+C', async () => {
		const { stdin, lastFrame } = await afterATurn()
		stdin.write(CTRL_O)
		await frameShows(lastFrame, 'Showing detailed transcript')
		stdin.write(CTRL_C)
		await frameLacks(lastFrame, 'Showing detailed transcript')
		expect(lastFrame() ?? '').not.toContain('again to exit')
	})

	it('Ctrl+E changes the footer line', async () => {
		const { stdin, lastFrame } = await afterATurn()
		stdin.write(CTRL_O)
		await frameShows(lastFrame, 'ctrl+e to show all')
		stdin.write(CTRL_E)
		await frameShows(lastFrame, 'ctrl+e to collapse')
		stdin.write(CTRL_E)
		await frameShows(lastFrame, 'ctrl+e to show all')
	})

	it('keeps drawing the reply that is still streaming', async () => {
		release = () => {}
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'a-model')
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		await frameShows(harness.lastFrame, 'body-line-12')

		harness.stdin.write(CTRL_O)
		await frameShows(harness.lastFrame, 'Showing detailed transcript')
		expect(harness.lastFrame() ?? '').not.toContain('late-words-arrived')
		release?.()
		await frameShows(harness.lastFrame, 'late-words-arrived')
		expect(harness.lastFrame() ?? '').toContain('Showing detailed transcript')
	})

	it('keeps the screen up for a request that arrives behind it, and shows the request after', async () => {
		let open!: () => void
		permissionGate = new Promise<void>((resolve) => {
			open = resolve
		})
		const { stdin, lastFrame } = await afterATurn()
		stdin.write(CTRL_O)
		await frameShows(lastFrame, 'Showing detailed transcript')

		open()
		await frameShows(lastFrame, 'dialog waiting')
		expect(lastFrame() ?? '', 'the request was drawn over the screen').not.toContain('1. Yes')
		expect(decisions, 'the request was decided without being seen').toEqual([])

		stdin.write('q')
		await frameShows(lastFrame, '1. Yes')
		expect(lastFrame() ?? '').not.toContain('Showing detailed transcript')
	})
})
