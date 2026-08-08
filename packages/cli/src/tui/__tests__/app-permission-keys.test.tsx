/**
 * What decides an open permission prompt — asserted against a rendered `<App>`.
 *
 * This is the first harness that mounts the root component. Everything in
 * `App.tsx`'s key handler was previously unreachable from a test: both existing
 * Ink harnesses render `<Picker>`, so the Ctrl+C ladder, the Esc-interrupt and
 * this prompt had no coverage at all. That gap is why `Ctrl+O` shipped inert and
 * why Enter could approve a tool call while being named on no screen.
 *
 * The scenario is the real one rather than a convenient one: a turn is running,
 * the operator is typing a follow-up into the composer (which stays live while
 * the agent works, and which the docs encourage using that way), and the agent
 * asks to run a tool. The overlay takes the screen under their hands.
 *
 * Not a terminal. This drives Ink's own stdin and reads Ink's own frames, so it
 * proves which handler ran and what it decided. Real key repeat, real paste
 * timing, terminal-specific escape sequences and how any of this FEELS at human
 * speed are outside what a harness can establish.
 */

import { render } from 'ink-testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../permission-timing.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Decisions the fake session was given, in order. */
const decisions: PermissionDecision[] = []
/** Resolves once the agent has asked and the overlay is up. */
let asked!: Promise<void>

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => null,
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	appendMessages: async () => {},
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
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: ['bash'],
			errorHint: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			close: async () => {},
			// Streams one delta so the composer is live and a draft can be typed,
			// then asks for permission and parks on the answer — which is exactly
			// the moment this file is about.
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: 'working' } as AgentEvent
				await new Promise((r) => setTimeout(r, 30))
				const req: PermissionRequest = {
					toolCalls: [
						{ id: 'call-1', name: 'bash', summary: 'rm -rf build', isDestructive: true },
					],
				}
				const decision = await opts?.onPermission?.(req)
				if (decision) decisions.push(decision)
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/**
 * Render, reach a running turn, type a draft, and stop with the prompt open.
 *
 * Returns once the overlay is on screen — every assertion below starts here, so
 * the setup is shared rather than restated with slightly different waits.
 */
async function promptOpenWithDraftInFlight() {
	const harness = render(<App ctx={ctx} />)
	// Probe → session → ready.
	await tick(60)
	// Start a turn.
	harness.stdin.write('go\r')
	await tick(40)
	// The follow-up the operator is part-way through typing while it runs.
	harness.stdin.write('and then deploy')
	await tick(40)
	expect(harness.lastFrame(), 'the prompt never opened').toContain('wants to run')
	return harness
}

beforeEach(() => {
	decisions.length = 0
	asked = Promise.resolve()
	void asked
})

describe('the permission prompt', () => {
	it('does not approve on Enter', async () => {
		// The heart of it. Enter is the key that submits the draft the operator
		// was typing, it is in flight exactly when the overlay appears, and it is
		// named on no screen — so it must decide nothing here.
		const { stdin, lastFrame, unmount } = await promptOpenWithDraftInFlight()

		stdin.write('\r')
		await tick(60)

		expect(decisions, 'Enter decided the prompt').toEqual([])
		expect(lastFrame(), 'the prompt closed without a decision').toContain('wants to run')
		unmount()
	})

	it('ignores an approving key that arrives before the prompt can have been read', async () => {
		// `y` is an ordinary letter. Someone mid-word when the overlay mounts is
		// one keystroke from approving a call they have not seen.
		const { stdin, unmount } = await promptOpenWithDraftInFlight()

		stdin.write('y')
		await tick(60)

		expect(decisions, 'an immediate y approved').toEqual([])
		unmount()
	})

	it('approves on y once the prompt has been up long enough to read', async () => {
		// The other half: the guard must not make the advertised key inert. A
		// deferred approval that never arrives is its own defect.
		const { stdin, unmount } = await promptOpenWithDraftInFlight()

		await tick(APPROVAL_SETTLE_MS + 60)
		stdin.write('y')
		await tick(60)

		expect(decisions).toEqual([{ kind: 'approve' }])
		unmount()
	})

	it('rejects on esc immediately, without waiting out the guard', async () => {
		// Refusal is not deferred: it is the recoverable direction, and a reject
		// key that ignored the first press would read as a frozen prompt.
		const { stdin, unmount } = await promptOpenWithDraftInFlight()

		stdin.write('\x1B')
		await tick(60)

		expect(decisions).toEqual([{ kind: 'reject' }])
		unmount()
	})

	it('names every key that decides it, and no key that does not', async () => {
		const { lastFrame, unmount } = await promptOpenWithDraftInFlight()
		const frame = lastFrame() ?? ''

		expect(frame).toContain('y')
		expect(frame).toContain('reject')
		expect(frame).toContain('approve all')
		expect(frame).toContain('esc')
		// The advertisement is the contract the handler is held to. `enter` must
		// not appear, because Enter no longer does anything here.
		expect(frame.toLowerCase()).not.toContain('enter')
		unmount()
	})
})
