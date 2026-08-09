/**
 * How you leave the provider picker.
 *
 * The picker has two entry points — first run, and `/model` from a working
 * session — and used to have one exit for both, plus no exit key at all.
 *
 * Both defects are the same missing idea: leaving the picker returns you to
 * whatever was there before it. From `/model` that is the session you already
 * had; on first run there is nothing behind it, so leaving the picker is
 * leaving the program.
 *
 * Two worlds are needed, so both are built here with a switchable probe rather
 * than in two files: `withSession` decides whether `probeAgentSession` returns
 * preferences (a session comes up, `/model` reopens the picker) or none (first
 * run, the picker is the first screen).
 *
 * Not a terminal. This drives Ink's own stdin, so it establishes which branch
 * ran and what it decided — not that a real tty delivers Ctrl+C as this harness
 * does. That Ink is launched with `exitOnCtrlC: false` is why the app has to
 * answer the key itself, and that half is `tui/index.tsx`, not here.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Whether the probe finds a saved provider (so a session comes up). */
let withSession = true
let exited = false

const DETECTED = [
	{
		entry: {
			id: 'openai',
			label: 'A Provider',
			defaultModel: 'a-default-model',
			requiresApiKey: true,
			envVars: ['A_KEY'],
		},
		source: { kind: 'env', envName: 'A_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: withSession ? PREFS : null,
			needsRepickReason: null,
			detected: DETECTED,
		}),
		describeProviderModels: async () => ({ kind: 'ok' as const, models: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => [],
			errorHint: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

vi.mock('ink', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ink')>()
	return {
		...actual,
		useApp: () => ({
			exit: () => {
				exited = true
			},
		}),
	}
})

const { App } = await import('../App.js')

/**
 * A SHORT cwd, deliberately, and the reason is a defect this file does not fix.
 *
 * `StatusBar` renders as one `<Text wrap="truncate-end">` with the working
 * directory first, so a deep path or a narrow terminal pushes the hint off the
 * end — and the hint is the only place the keys are advertised. Under this
 * repo's own worktree path the whole hint disappears.
 *
 * So the two hint assertions below establish that the right hint is BUILT, not
 * that an operator can see it. Those are different claims and the second one is
 * currently false on a long path; it is filed separately rather than smuggled
 * in here, because fixing it means deciding what the footer drops first.
 */
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

/**
 * Wait for the app to ask Ink to exit, or give up.
 *
 * Polling, not a fixed sleep, and the reason showed up while mutation-checking
 * rather than in the green run. A bare `\x1B` is held briefly by the input
 * parser to see whether an escape sequence follows; under load that outlasts a
 * fixed wait, the assertion fails, and the exit then lands DURING THE NEXT TEST
 * — which shares this flag and passes for a reason that has nothing to do with
 * what it asserts. A test made green by its predecessor's late keystroke is
 * worse than a failing one.
 */
async function exitedWithin(timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!exited && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

async function frameShows(
	lastFrame: () => string | undefined,
	text: string,
	timeoutMs = 3_000,
): Promise<void> {
	const started = performance.now()
	while (!(lastFrame() ?? '').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

beforeEach(() => {
	exited = false
	withSession = true
})

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/** A ready session, then `/model` to open the picker over the top of it. */
async function pickerFromModelCommand() {
	withSession = true
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	// `frameShows` returns on the render that first shows the composer, which
	// can be the same tick its input handler is being registered on. Writing
	// immediately loses the keystrokes, so let the mount settle.
	await tick(80)
	harness.stdin.write('/model')
	await tick(60)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'Choose a provider')
	expect(harness.lastFrame(), 'the picker never opened').toContain('Choose a provider')
	await tick(60)
	return harness
}

/** First run: no saved provider, so the picker is the first screen. */
async function pickerOnFirstRun() {
	withSession = false
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Choose a provider')
	expect(harness.lastFrame(), 'the picker never opened').toContain('Choose a provider')
	return harness
}

describe('cancelling the picker opened by /model', () => {
	it('returns to the session that was already running', async () => {
		// The defect: declining to change model threw away a working session,
		// landing on a phase whose composer is disabled and from which `/model`
		// cannot be typed again.
		const { stdin, lastFrame } = await pickerFromModelCommand()

		stdin.write('\x1B')
		await frameShows(lastFrame, 'Type a message')

		expect(lastFrame(), 'did not return to the chat').toContain('Type a message')
		expect(exited, 'cancelling a re-pick exited the program').toBe(false)
	})

	it('leaves the composer usable, which is what being stranded took away', async () => {
		// The sharper form of the same claim. `unhealthy` disables the composer,
		// and `/model` cannot be typed from there either — so the operator had
		// no way back to the picker and no way to talk to the agent. Asserting
		// on the hint text would not have caught this: the ready hint ends with
		// the same "Ctrl+C ×2 to exit" the unhealthy hint consists of.
		const { stdin, lastFrame } = await pickerFromModelCommand()

		stdin.write('\x1B')
		await frameShows(lastFrame, 'Type a message')

		stdin.write('still here')
		await frameShows(lastFrame, 'still here')

		expect(lastFrame(), 'the composer would not accept input').toContain('still here')
	})
})

describe('cancelling the picker on first run', () => {
	it('leaves the program, because there is nothing behind it', async () => {
		const { stdin } = await pickerOnFirstRun()

		stdin.write('\x1B')
		await exitedWithin()

		expect(exited, 'esc on the first-run picker did not exit').toBe(true)
	})
})

describe('Ctrl+C in the picker', () => {
	it('exits on first run', async () => {
		// The first screen a new user sees. Ink runs with `exitOnCtrlC: false`
		// and this handler used to be switched off for the whole picker phase,
		// so the key did nothing whatsoever.
		const { stdin } = await pickerOnFirstRun()

		stdin.write('\x03')
		await exitedWithin()

		expect(exited, 'Ctrl+C did nothing in the picker').toBe(true)
	})

	it('exits from a picker opened by /model too', async () => {
		const { stdin } = await pickerFromModelCommand()

		stdin.write('\x03')
		await exitedWithin()

		expect(exited).toBe(true)
	})

	it('does not disturb the keys the picker owns', async () => {
		// Making App's handler active for this phase must not make it a second
		// consumer of navigation. Down-arrow still belongs to the picker.
		const { stdin, lastFrame } = await pickerOnFirstRun()

		stdin.write('[B')
		await tick(80)

		expect(exited, 'an arrow key exited the program').toBe(false)
		expect(lastFrame(), 'the picker stopped drawing').toContain('Choose a provider')
	})
})

describe('the picker hint', () => {
	it('names an exit on first run, where nothing else is on screen', async () => {
		const { lastFrame } = await pickerOnFirstRun()
		const frame = lastFrame() ?? ''

		expect(frame).toContain('Ctrl+C')
		expect(frame).toContain('exit')
	})

	it('says esc keeps the current model when there is a session behind it', async () => {
		const { lastFrame } = await pickerFromModelCommand()
		const frame = lastFrame() ?? ''

		expect(frame).toContain('keep current')
		expect(frame).toContain('Ctrl+C')
	})
})
