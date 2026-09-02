/**
 * A saved provider with no credential must land somewhere an operator can act.
 *
 * The defect this pins: a saved primary that requires a key, launched on a
 * machine with none, produced an empty session — `hasProvider: false` — which
 * sets the `unhealthy` phase. That phase is a disabled composer whose only hint
 * is "Ctrl+C x2 to exit", and the refusal printed on it ended with "or pick
 * another provider". The advice named the one screen that cannot follow it.
 *
 * ## Why this drives `<App>` on a screen and not a helper
 *
 * Every piece of this existed already and none of it was reachable. The picker
 * could take a credential; the probe could see there was none; the phase
 * machine could route. Only a mounted app decides which of those runs, so a
 * unit test on any one of them stays green with the operator still stranded —
 * see "mutation check every test" on a helper test not
 * proving its caller.
 *
 * Asserting on the MESSAGE would prove nothing at all: the message was always
 * there. What was missing is a screen that can act on it, so what is asserted
 * is what the operator can reach — the credential field, the disclosure it
 * makes, and a running session on the other side of it.
 *
 * The real `probeAgentSession` runs here. Only its two inputs are replaced (the
 * preferences file, and what discovery found), because those are the machine
 * this operator was sitting at.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
	DetectedProvider,
	Preferences,
	ProviderId,
} from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { renderToScreen, type Screen } from './support/screen.js'

/**
 * The three providers this exercises, named as ids and looked up.
 *
 * Ids are wire values and live in string literals; labels are read from the
 * registry rather than spelled out. A test that hardcodes a label both plants a
 * third-party name in tracked prose and goes stale the day the registry is
 * reworded.
 */
const SAVED: ProviderId = 'anthropic'
const OTHER_KEY_PROVIDER: ProviderId = 'openai'
const LOCAL: ProviderId = 'ollama'

const SAVED_LABEL = PROVIDER_REGISTRY[SAVED].label
const OTHER_KEY_LABEL = PROVIDER_REGISTRY[OTHER_KEY_PROVIDER].label

/** The operator's file: a provider chosen, and a model pinned on it. */
const SAVED_PREFS: Preferences = {
	version: 3,
	providers: [{ id: SAVED, model: 'a-pinned-model' }],
	subagents: { active: [] },
}

/** A local server, which needs no key — so the picker draws a populated list. */
const LOCAL_ONLY: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY[LOCAL],
		source: { kind: 'probe', url: 'http://localhost:11434' },
		alternatives: [],
	},
]

const world: {
	prefs: Preferences
	detected: readonly DetectedProvider[]
	built: Preferences | null
	credentials: DetectedProvider[]
} = { prefs: SAVED_PREFS, detected: [], built: null, credentials: [] }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

// The machine, not the logic. `readPreferences` and `discoverProviders` are the
// two leaves the real probe reads; everything between them stays real.
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		readPreferences: () => ({ status: 'ok' as const, prefs: world.prefs }),
		discoverProviders: async () => world.detected,
		writePreferences: () => {},
	}
})

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		describeProviderModels: async () => ({ kind: 'ok' as const, models: [] }),
		// The provider's answer, stubbed. Verification honesty is pinned by
		// `credential-prompt-draws.test.tsx`; what matters here is that a good
		// credential carries on into a session.
		verifyCredential: async () => ({ kind: 'verified' as const }),
		createAgentSession: async (prefs: Preferences, det: readonly DetectedProvider[]) => {
			world.built = prefs
			world.credentials = det.filter((d) => d.source.kind === 'session')
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'a-provider',
				modelSummary: prefs.providers[0]?.model ?? 'a-model',
				toolNames: () => [],
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
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (): AsyncIterable<AgentEvent> {
					yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
				},
			} satisfies AgentSession
		},
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }

/** Everything the emulator holds, so a line that scrolled off still counts. */
function text(screen: Screen): string {
	return screen.scrollback().join('\n')
}

/**
 * Poll until the screen says `needle`, or give up.
 *
 * A poll on a condition, not a fixed wait: the app's launch path is two awaited
 * promises deep and a duration here would be the scaffolding flake this suite
 * has already had three of.
 */
async function until(screen: Screen, needle: string, attempts = 400): Promise<void> {
	for (let i = 0; i < attempts; i += 1) {
		if (text(screen).includes(needle)) return
		await new Promise((r) => setTimeout(r, 0))
		await screen.waitForRender()
	}
}

async function launch(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 40 })
	await until(screen, 'No credential found')
	return screen
}

beforeEach(() => {
	world.prefs = SAVED_PREFS
	world.detected = []
	world.built = null
	world.credentials = []
})

describe('launching with a saved provider and no credential', () => {
	it('reaches a screen that takes a credential, not a disabled composer', async () => {
		const screen = await launch()
		try {
			// The refusal, and then the thing that makes it a refusal rather than a
			// dead end: the picker, which `unhealthy` is not.
			expect(text(screen)).toContain('No credential found')
			expect(text(screen), 'landed on the phase with no way out').not.toContain(
				'Ctrl+C ×2 to exit',
			)

			screen.press('k')
			await until(screen, 'Paste a credential')

			expect(text(screen)).toContain('Paste a credential')
			// For the provider that was actually missing one.
			expect(text(screen)).toContain(SAVED_LABEL)
		} finally {
			await screen.unmount()
		}
	})

	it('starts the session from what was typed, without leaving the program', async () => {
		const screen = await launch()
		try {
			screen.press('k')
			await until(screen, 'Paste a credential')
			screen.press('sk-ant-api03-not-a-real-key')
			await until(screen, '••••')
			screen.press('\r')
			await until(screen, 'Type a message')

			// The whole point of the change: a running session, reached from inside
			// namzu by an operator who launched it with nothing.
			expect(text(screen), 'never reached a usable composer').toContain('Type a message')
			expect(world.built, 'no session was built').not.toBeNull()
			expect(world.credentials, 'the typed credential never reached the session').toHaveLength(1)
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the model the file pinned, having only been missing a secret', async () => {
		const screen = await launch()
		try {
			screen.press('k')
			await until(screen, 'Paste a credential')
			screen.press('sk-ant-api03-not-a-real-key')
			await until(screen, '••••')
			screen.press('\r')
			await until(screen, 'Type a message')

			// Rebuilding the chain from the provider id alone would silently move
			// this operator onto the registry default for the crime of supplying a
			// key.
			expect(world.built?.providers[0]?.model).toBe('a-pinned-model')
		} finally {
			await screen.unmount()
		}
	})

	it('says it took a subscription token, and that it will lapse', async () => {
		const screen = await launch()
		try {
			screen.press('k')
			await until(screen, 'Paste a credential')
			screen.press('sk-ant-oat01-not-a-real-token')
			await until(screen, 'Reads as a subscription token')

			// Told at the paste, on the value they actually typed. Discovering it as
			// a 401 mid-turn is the difference between a feature and a trap.
			expect(text(screen)).toContain('Reads as a subscription token')
			expect(text(screen)).toContain('expires')

			screen.press('\r')
			await until(screen, 'Type a message')
			expect(text(screen), 'the disclosure did not survive into the session').toContain(
				'no refresh data',
			)
		} finally {
			await screen.unmount()
		}
	})
})

describe('after the credential has been supplied', () => {
	it('does not keep explaining a problem that is solved', async () => {
		// The failure path of the routing rather than its happy path: a launch
		// refusal left on the picker would greet an operator who opens `/model`
		// from a working session with the reason their PREVIOUS launch failed, and
		// offer to fix a credential they already entered.
		const screen = await launch()
		try {
			screen.press('k')
			await until(screen, 'Paste a credential')
			screen.press('sk-ant-api03-not-a-real-key')
			await until(screen, '••••')
			screen.press('\r')
			await until(screen, 'Type a message')

			screen.press('/model')
			await until(screen, '/model')
			screen.press('\r')
			await until(screen, 'Choose a provider')

			// The LIVE picker box, not the whole viewport. The launch refusal is
			// also sitting further up the terminal as transcript history, which is
			// where it belongs and must not be asserted away — the claim here is
			// about what the picker itself is drawing right now.
			const rows = screen.viewport()
			const lastBorder = rows.reduce((at, row, i) => (row.includes('╭') ? i : at), 0)
			const box = rows.slice(lastBorder)
			const drawn = box.join('\n')

			expect(drawn, 'the picker never reopened').toContain('Choose a provider')
			expect(drawn, 'a stale launch refusal is drawn on the picker').not.toContain(
				'No credential found',
			)
			expect(drawn, 'still offering to repair a credential that is present').not.toContain(
				'k enter a credential',
			)
		} finally {
			await screen.unmount()
		}
	})
})

describe('when something else is running on the machine', () => {
	it('still offers to take a credential for the saved provider', async () => {
		// The case the old "empty screen only" gate got wrong. A local server is
		// detected, so the picker draws a list — and the operator's actual problem,
		// a missing key for the provider they chose, is not on it.
		world.detected = LOCAL_ONLY
		const screen = await launch()
		try {
			expect(text(screen), 'the populated list never drew').toContain('Choose a provider')
			// Advertised before it is pressed: a key nothing on screen names is a
			// key nobody presses.
			expect(text(screen)).toContain('k enter a credential')

			screen.press('k')
			await until(screen, 'Paste a credential')

			expect(text(screen)).toContain('Paste a credential')
			expect(text(screen)).toContain(SAVED_LABEL)
		} finally {
			await screen.unmount()
		}
	})
})

describe('the credential is for the provider that needed one', () => {
	it('targets the saved provider, not the first one in the registry', async () => {
		// Entry used to address a fixed index into the key-capable list, which is
		// the FIRST such provider whatever was saved. With that provider saved the
		// bug is invisible, so this saves a different one.
		world.prefs = { version: 3, providers: [{ id: OTHER_KEY_PROVIDER }], subagents: { active: [] } }
		const screen = await launch()
		try {
			screen.press('k')
			await until(screen, 'Paste a credential')

			expect(text(screen)).toContain(OTHER_KEY_LABEL)
			expect(text(screen), 'the credential was offered to the wrong provider').not.toContain(
				SAVED_LABEL,
			)
		} finally {
			await screen.unmount()
		}
	})
})
