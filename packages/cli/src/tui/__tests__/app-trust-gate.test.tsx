/**
 * What grants trust at the folder gate, asserted against a rendered `<App>`.
 *
 * A separate file from `app-permission-keys.test.tsx` because the two need
 * opposite worlds: that one mocks `isTrusted` to true so it can reach a running
 * turn, this one needs it false so the gate appears at all. Module mocks are
 * per-file, so the split is structural rather than stylistic.
 *
 * The gate is the program's FIRST screen, and it is reached by typing `namzu`
 * and pressing Enter — which is why Enter granting trust was the sharper of the
 * two instances of this bug. What it grants is durable: `trustDir` writes the
 * folder into `~/.namzu/trust.json`, covering every subfolder.
 *
 * Not a terminal. This drives Ink's own stdin, so it establishes which branch
 * ran and what it decided. Whether a real tty delivers a launch keystroke into
 * this window — the thing the guard exists for — is exactly what a harness
 * cannot establish, and only using it can.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { TuiContext } from '../types.js'
import { bindTrustedProjectContext } from '../../config/trusted-project-context.js'

/** Folders handed to `trustDir`, in order. The durable side effect. */
const trusted: string[] = []
/** Set when the app asked Ink to exit. */
let exited = false
const lifecycle = vi.hoisted(() => ({
	events: [] as string[],
	canonical: new Map<string, string>(),
}))

vi.mock('../../permissions/canonical-project.js', () => ({
	canonicalProjectPath: (dir: string) => lifecycle.canonical.get(dir) ?? dir,
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => false,
	trustDir: (dir: string) => {
		trusted.push(dir)
	},
}))

vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

// Probing must never happen here: reaching it would mean the gate was passed.
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => {
			lifecycle.events.push('probe')
			return {
				preferences: null,
				needsRepickReason: null,
				detected: [],
			}
		},
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

const ctx: TuiContext = { cwd: 'C:/a/folder', version: '0.0.0-test' }

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

let nowMs = 1_000_000
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	trusted.length = 0
	lifecycle.events.length = 0
	lifecycle.canonical.clear()
	exited = false
	nowMs = 1_000_000
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/** Wait for the durable trust write, or give up. */
async function trustedWithin(timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (trusted.length === 0 && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

/** Move the stubbed clock past the settle window. */
function settle(): void {
	nowMs += APPROVAL_SETTLE_MS + 1
}

async function gateOnScreen(context: TuiContext = ctx) {
	const harness = render(<App ctx={context} />)
	mounted.push(harness)
	// Poll for the gate, then let its effects flush. The effect that stamps when
	// the gate appeared runs after the commit that draws it, and the settle
	// window is measured from that stamp — so pressing a key in the gap between
	// "drawn" and "stamped" is measured against no stamp at all and refused.
	// A fixed wait here made that gap load-dependent.
	const started = performance.now()
	while (
		!(harness.lastFrame() ?? '').includes('Do you trust') &&
		performance.now() - started < 3_000
	) {
		await tick(20)
	}
	expect(harness.lastFrame(), 'the trust gate never appeared').toContain('Do you trust')
	await tick(60)
	return harness
}

describe('the trust gate', () => {
	it('does not grant trust on Enter, even once the gate has settled', async () => {
		// The launch keystroke. Waiting out the window first is what gives this
		// its teeth: pressed immediately, the settle guard would swallow Enter
		// whether or not the branch still read `key.return`.
		const { stdin } = await gateOnScreen()

		settle()
		stdin.write('\r')
		await tick(400)

		expect(trusted, 'Enter wrote durable trust').toEqual([])
		expect(exited, 'Enter exited').toBe(false)
	})

	it('ignores y arriving before the gate can have been read', async () => {
		const { stdin } = await gateOnScreen()

		stdin.write('y')
		await tick(400)

		expect(trusted, 'an immediate y granted trust').toEqual([])
	})

	it('grants trust on y once the gate has been up long enough to read', async () => {
		// The guard must not make the advertised key inert.
		const { stdin } = await gateOnScreen()

		settle()
		stdin.write('y')
		// Polled, not slept. A fixed wait here passed alone and failed inside the
		// full parallel run — the same transform-load cliff this suite has met
		// before, and a flake in the waiting rather than in what is asserted.
		await trustedWithin()

		expect(trusted).toEqual(['C:/a/folder'])
	})

	it('activates project config after trust and before probing', async () => {
		const gated = bindTrustedProjectContext({ ...ctx }, (cwd) => {
			lifecycle.events.push(`activate:${cwd}`)
			return { ...ctx, cwd }
		})
		const { stdin } = await gateOnScreen(gated)

		settle()
		stdin.write('y')
		await trustedWithin()
		const started = performance.now()
		while (!lifecycle.events.includes('probe') && performance.now() - started < 3_000) {
			await tick(20)
		}

		expect(lifecycle.events).toEqual(['activate:C:/a/folder', 'probe'])
	})

	it('pins the canonical folder for trust and project activation', async () => {
		lifecycle.canonical.set('C:/alias', 'C:/real/project')
		const lexical = { ...ctx, cwd: 'C:/alias' }
		const gated = bindTrustedProjectContext(lexical, (cwd) => {
			lifecycle.events.push(`activate:${cwd}`)
			return { ...lexical, cwd }
		})
		const { stdin } = await gateOnScreen(gated)

		settle()
		stdin.write('y')
		await trustedWithin()
		const started = performance.now()
		while (!lifecycle.events.includes('probe') && performance.now() - started < 3_000) {
			await tick(20)
		}

		expect(trusted).toEqual(['C:/real/project'])
		expect(lifecycle.events).toEqual(['activate:C:/real/project', 'probe'])
	})

	it('does not probe or construct a session when trusted project config is invalid', async () => {
		const gated = bindTrustedProjectContext({ ...ctx }, () => {
			lifecycle.events.push('activate')
			throw new Error('malformed project config')
		})
		const harness = await gateOnScreen(gated)

		settle()
		harness.stdin.write('y')
		await trustedWithin()
		const started = performance.now()
		while (
			!(harness.lastFrame() ?? '').includes('malformed project config') &&
			performance.now() - started < 3_000
		) {
			await tick(20)
		}

		expect(lifecycle.events).toEqual(['activate'])
		expect(harness.lastFrame()).toContain('Could not activate project config')
		expect(harness.lastFrame()).toContain('malformed project config')
	})

	it('exits on n immediately, without waiting out the guard', async () => {
		// Refusal is not deferred. Nothing is written and nothing has run, so an
		// accidental exit costs a relaunch — the recoverable direction.
		const { stdin } = await gateOnScreen()

		stdin.write('n')
		await tick(200)

		expect(exited).toBe(true)
		expect(trusted).toEqual([])
	})

	it('exits on esc immediately as well', async () => {
		const { stdin } = await gateOnScreen()

		stdin.write('\x1B')
		await tick(300)

		expect(exited).toBe(true)
		expect(trusted).toEqual([])
	})

	it('names every key that decides it, and no key that does not', async () => {
		// Asserted against the whole frame, deliberately. Two surfaces advertise
		// these keys — the prompt box and the status hint — and the operator
		// sees one screen, so the property worth pinning is "the screen says
		// so", not "this component says so". Confirmed by mutation: removing
		// `esc` from either one alone leaves the screen still naming it and this
		// test still passing, which is correct; removing it from both kills it.
		const { lastFrame } = await gateOnScreen()
		const frame = lastFrame() ?? ''

		expect(frame).toContain('y')
		expect(frame).toContain('trust this folder')
		expect(frame).toContain('esc')
		expect(frame).toContain('exit')
		// Enter grants nothing, so it must not be advertised as if it did.
		expect(frame.toLowerCase()).not.toContain('enter')
	})
})
