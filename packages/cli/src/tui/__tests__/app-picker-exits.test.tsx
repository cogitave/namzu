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
let emptyDetection = false
let exited = false
let probeCalls = 0
let detectedProviders: readonly DetectedProvider[]
let writePrefs = vi.fn()
let beginLogin: typeof import('../../integrations/providers/index.js').beginSubscriptionLogin =
	async () => {
		throw new Error('sign-in was not arranged by this test')
	}
let createSession: typeof import('../agent.js').createAgentSession

const DETECTED = [
	{
		entry: {
			id: 'openai',
			label: 'A Provider',
			defaultModel: 'a-default-model',
			requiresApiKey: true,
			envVars: ['A_KEY'],
			constructible: true,
		},
		source: { kind: 'env', envName: 'A_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

const DETECTED_B = {
	entry: {
		id: 'deepseek',
		label: 'B Provider',
		defaultModel: 'b-default-model',
		requiresApiKey: true,
		envVars: ['B_KEY'],
		constructible: true,
	},
	source: { kind: 'env', envName: 'B_KEY' },
	apiKey: 'also-not-a-real-key',
	alternatives: [],
} as unknown as DetectedProvider

function sessionFixture(providerSummary = 'a-provider', close = vi.fn()): AgentSession {
	return {
		hasProvider: true,
		sandbox: { unconfined: true, enforced: [], required: [] },
		compact: async () => null,
		providerSummary,
		modelSummary: 'a-model',
		toolNames: () => [],
		errorHint: null,
		errorKind: null,
		instructionFiles: [],
		skippedInstructionFiles: [],
		mcpConnected: [],
		mcpFailed: [],
		agentIds: [],
		configNotices: [],
		// The TUI never resumes a durable run; a stub that answered would
		// make a resume look reachable from here.
		resumeDurable: async () => {
			throw new Error('not used by the TUI')
		},
		close,
		approvalLatched: () => false,
		promptExemptTools: () => [],
		send: async function* (): AsyncIterable<AgentEvent> {
			yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
		},
	}
}

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

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		writePreferences: (...args: Parameters<typeof actual.writePreferences>) => writePrefs(...args),
		beginSubscriptionLogin: (
			...args: Parameters<typeof actual.beginSubscriptionLogin>
		): ReturnType<typeof actual.beginSubscriptionLogin> => beginLogin(...args),
	}
})

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => {
			probeCalls += 1
			return {
				preferences: withSession ? PREFS : null,
				needsRepickReason: null,
				detected: emptyDetection ? [] : detectedProviders,
			}
		},
		describeProviderModels: async () => ({ kind: 'ok' as const, models: [] }),
		verifyCredential: async () => ({ kind: 'verified' as const }),
		createAgentSession: (...args: Parameters<typeof createSession>) => createSession(...args),
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

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

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
	emptyDetection = false
	probeCalls = 0
	detectedProviders = DETECTED
	writePrefs = vi.fn()
	createSession = async (prefs) => sessionFixture(`${prefs.providers[0]?.id ?? 'none'}-provider`)
	beginLogin = async () => {
		throw new Error('sign-in was not arranged by this test')
	}
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
async function pickerOnFirstRun(expected = 'Choose a provider') {
	withSession = false
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, expected)
	expect(harness.lastFrame(), 'the picker never opened').toContain(expected)
	return harness
}

describe('publishing a picker selection', () => {
	it('keeps the newest session when an older construction settles last', async () => {
		withSession = false
		detectedProviders = [...DETECTED, DETECTED_B]
		const a = deferred<AgentSession>()
		const b = deferred<AgentSession>()
		const closeA = vi.fn(async () => {})
		const closeB = vi.fn(async () => {})
		const constructed: string[] = []
		createSession = async (prefs) => {
			const id = prefs.providers[0]?.id ?? 'none'
			constructed.push(id)
			return id === 'openai' ? a.promise : b.promise
		}
		const { stdin, lastFrame } = await pickerOnFirstRun()

		// Start A, then back out while its session construction is still pending.
		stdin.write('\r')
		await frameShows(lastFrame, 'Choose a model')
		stdin.write('\r')
		await vi.waitFor(() => expect(constructed).toEqual(['openai']))
		stdin.write('\x1B')
		await frameShows(lastFrame, 'Choose a provider')

		// Select B and let the newer construction publish first.
		stdin.write('\x1B[B')
		await tick()
		stdin.write('\r')
		await frameShows(lastFrame, 'Choose a model')
		stdin.write('\r')
		await vi.waitFor(() => expect(constructed).toEqual(['openai', 'deepseek']))
		b.resolve(sessionFixture('b-session', closeB))
		await frameShows(lastFrame, 'Connected to b-session')
		expect(lastFrame()).toContain('Connected to b-session')

		// A is no longer the owner. Its late object is disposed, not published over B.
		a.resolve(sessionFixture('a-session', closeA))
		await vi.waitFor(() => expect(closeA).toHaveBeenCalledTimes(1))
		expect(closeB).not.toHaveBeenCalled()
		expect(lastFrame()).toContain('Connected to b-session')
		expect(lastFrame()).not.toContain('Connected to a-session')
		expect(writePrefs.mock.calls.at(-1)?.[0]).toMatchObject({
			providers: [{ id: 'deepseek' }],
		})
	})

	it('keeps the current session when the selected session cannot be constructed', async () => {
		detectedProviders = [...DETECTED, DETECTED_B]
		const closeA = vi.fn(async () => {})
		const failure = new Error('required sandbox unavailable')
		createSession = async (prefs) => {
			const id = prefs.providers[0]?.id
			if (id === 'deepseek') throw failure
			return sessionFixture('a-session', closeA)
		}
		const { stdin, lastFrame } = await pickerFromModelCommand()

		stdin.write('\x1B[B')
		await tick()
		stdin.write('\r')
		await frameShows(lastFrame, 'Choose a model')
		stdin.write('\r')
		await frameShows(lastFrame, failure.message)

		expect(lastFrame()).toContain('Could not start the selected provider')
		expect(lastFrame()).toContain(failure.message)
		expect(closeA).not.toHaveBeenCalled()

		// Back through the model step, then out of /model to the still-live A.
		stdin.write('\x1B')
		await frameShows(lastFrame, 'Choose a provider')
		stdin.write('\x1B')
		await frameShows(lastFrame, 'Type a message')
		expect(lastFrame()).toContain('a-session')
		expect(closeA).not.toHaveBeenCalled()
	})

	it('does not replace a working session with a provider-less candidate', async () => {
		detectedProviders = [...DETECTED, DETECTED_B]
		const closeA = vi.fn(async () => {})
		const closeB = vi.fn(async () => {})
		const unavailable = 'B provider is unavailable'
		createSession = async (prefs) => {
			const id = prefs.providers[0]?.id
			if (id !== 'deepseek') return sessionFixture('a-session', closeA)
			return {
				...sessionFixture('b-session', closeB),
				hasProvider: false,
				errorHint: unavailable,
			}
		}
		const { stdin, lastFrame } = await pickerFromModelCommand()

		stdin.write('\x1B[B')
		await tick()
		stdin.write('\r')
		await frameShows(lastFrame, 'Choose a model')
		stdin.write('\r')
		await frameShows(lastFrame, unavailable)

		expect(lastFrame()).toContain(unavailable)
		expect(closeB).toHaveBeenCalledTimes(1)
		expect(closeA).not.toHaveBeenCalled()

		stdin.write('\x1B')
		await frameShows(lastFrame, 'Choose a provider')
		stdin.write('\x1B')
		await frameShows(lastFrame, 'Type a message')
		expect(lastFrame()).toContain('a-session')
		expect(closeA).not.toHaveBeenCalled()
	})

	it('disposes a typed-credential session when its picker operation is withdrawn', async () => {
		withSession = false
		emptyDetection = true
		const candidate = deferred<AgentSession>()
		const closeCandidate = vi.fn(async () => {})
		let constructionStarted = false
		createSession = async () => {
			constructionStarted = true
			return candidate.promise
		}
		const { stdin, lastFrame } = await pickerOnFirstRun('No providers detected')

		stdin.write('k')
		await frameShows(lastFrame, 'Paste a credential')
		stdin.write('sk-ant-api03-notarealkey-0123beef')
		await tick()
		stdin.write('\r')
		await vi.waitFor(() => expect(constructionStarted).toBe(true))

		stdin.write('\x1B')
		await frameShows(lastFrame, 'Choose a provider')
		candidate.resolve(sessionFixture('late-credential-session', closeCandidate))
		await vi.waitFor(() => expect(closeCandidate).toHaveBeenCalledTimes(1))

		expect(lastFrame()).not.toContain('Connected to late-credential-session')
	})
})

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

	it('cancels a sign-in whose handle arrives after the picker was left', async () => {
		emptyDetection = true
		let release: (login: Awaited<ReturnType<typeof beginLogin>>) => void = () => {}
		let pickerSignal: AbortSignal | undefined
		const pendingStart = new Promise<Awaited<ReturnType<typeof beginLogin>>>((resolve) => {
			release = resolve
		})
		const cancel = vi.fn()
		const waitForCallback = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				credential: { accessToken: 'not-a-real-token' },
				storedAt: '/not/written',
			}),
		)
		beginLogin = (options = {}) => {
			pickerSignal = options.signal
			return pendingStart
		}
		const { stdin, lastFrame } = await pickerOnFirstRun('No providers detected')

		await tick(80)
		stdin.write('l')
		await vi.waitFor(() => expect(pickerSignal).toBeDefined())
		stdin.write('\x1B')
		await exitedWithin()
		expect(pickerSignal?.aborted).toBe(true)

		release({
			url: 'https://example.test/authorize',
			redirectUri: 'http://127.0.0.1/callback',
			loopback: true,
			waitForCallback,
			completeWithPastedCode: async () => ({ ok: false, reason: 'not used' }),
			cancel,
		})
		await tick(80)

		expect(cancel).toHaveBeenCalledTimes(1)
		expect(waitForCallback).not.toHaveBeenCalled()
		expect(probeCalls, 'a cancelled login re-probed the machine').toBe(1)
		expect(lastFrame()).not.toContain('example.test')
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
