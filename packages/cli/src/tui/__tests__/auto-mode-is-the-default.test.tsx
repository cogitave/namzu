/**
 * Auto mode is where an interactive terminal starts when nothing chose a mode.
 *
 * The launch plan leaves it to the session (`permissionSource: 'auto-default'`)
 * because only a built session knows whether its classifier can reach a model.
 * These drive a rendered `<App>` against a mocked session: the default applies
 * when the classifier can answer and falls back to `prompt`, silently, when it
 * cannot; a mode someone chose is never replaced; the one-time notice shows
 * once per person and is written to the acknowledgements file; and a turn
 * that auto mode stopped for want of a verdict says so in one sentence and
 * leaves the mode alone.
 *
 * Nothing here races the clock: each wait loops until the screen, the file or
 * the mock says what it waits for, and Vitest's own timeout catches a hang.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import {
	AUTO_MODE_DEFAULT_NOTICE_TITLE,
	acknowledgementsPath,
	hasSeenAutoModeDefaultNotice,
	markAutoModeDefaultNoticeSeen,
} from '../../permissions/consent.js'
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

/** Whether the mocked session can run the auto mode's classifier. */
let autoModeUsable = true
/** The mode the last turn was sent with. */
let sentMode: string | undefined
/** The callback the turn hands the kernel for a classifier that stopped. */
let limitHandler:
	| ((event: { limit: 'consecutive' | 'total' | 'unavailable'; reason: string }) => void)
	| undefined
let turnsSent = 0
let sessionShown = false
/** Sessions built so far; a model switch builds another. */
let built = 0
/** What the probe finds; a model switch needs the provider it names. */
let detectedProviders: readonly DetectedProvider[] = []
const DETECTED = {
	entry: {
		id: 'openai',
		label: 'A Provider',
		vendor: 'openai',
		defaultModel: 'a-model',
		requiresApiKey: true,
		envVars: ['A_KEY'],
		constructible: true,
	},
	source: { kind: 'env', envName: 'A_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
} as unknown as DetectedProvider

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: detectedProviders,
		}),
		describeProviderModels: async () => ({
			kind: 'ok' as const,
			models: [
				{ id: 'a-model', name: 'a-model' },
				{ id: 'b-model', name: 'b-model' },
			],
		}),
		verifyCredential: async () => ({ kind: 'verified' as const }),
		createAgentSession: async (): Promise<AgentSession> => ({
			...(() => {
				built += 1
				return {}
			})(),
			hasProvider: true,
			get providerSummary() {
				// Read when the published session is drawn, which is after its mode was settled.
				sessionShown = true
				return 'a-provider'
			},
			get autoMode() {
				return autoModeUsable
					? { available: true }
					: { available: false, reason: 'Auto mode has no model to ask in this test.' }
			},
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			setPermissionMode: async () => {},
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				sentMode = opts?.permissionMode
				limitHandler = opts?.onAutoModeLimit
				turnsSent += 1
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const {
	App,
	AUTO_MODE_DEFAULT_LEFT_NOTICE,
	AUTO_MODE_DEFAULT_STOPPED_NOTICE,
	AUTO_MODE_STOPPED_NOTICE,
} = await import('../App.js')

const base: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
	permissionSource: 'auto-default',
} as unknown as TuiContext

// The acknowledgements file is removed before every test, so it must be this
// file's own: a NAMZU_HOME inherited from the shell would be a person's.
const inherited = process.env.NAMZU_HOME
const home = mkdtempSync(join(tmpdir(), 'namzu-auto-default-'))
beforeAll(() => {
	process.env.NAMZU_HOME = home
})
afterAll(() => {
	if (inherited === undefined) delete process.env.NAMZU_HOME
	else process.env.NAMZU_HOME = inherited
	removeTempDir(home)
})

const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => rmSync(acknowledgementsPath(), { force: true }))
afterEach(() => {
	autoModeUsable = true
	sentMode = undefined
	limitHandler = undefined
	turnsSent = 0
	sessionShown = false
	built = 0
	detectedProviders = []
	for (const m of mounted.splice(0)) m.unmount()
	vi.clearAllMocks()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
/** Waits, with no deadline of its own, until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	while (!check()) await settle()
}
const flat = (harness: ReturnType<typeof render>) => harness.frames.join('\n').replace(/\s+/g, ' ')

async function mount(extra: Partial<TuiContext> = {}) {
	const harness = render(<App ctx={{ ...base, ...extra }} />)
	mounted.push(harness)
	await until(() => sessionShown && (harness.lastFrame() ?? '').includes('Type a message'))
	return harness
}

/** Sends one message and waits for the turn to be handed to the session. */
async function sendOne(harness: ReturnType<typeof render>): Promise<void> {
	const before = turnsSent
	harness.stdin.write('hello')
	await settle()
	harness.stdin.write('\r')
	await until(() => turnsSent > before)
}

describe('a terminal nobody chose a mode for', () => {
	it('starts in auto when the classifier can reach a model, and says so once', async () => {
		const harness = await mount()
		await until(() => flat(harness).includes('auto mode on'))
		await until(() => flat(harness).includes(AUTO_MODE_DEFAULT_NOTICE_TITLE))
		const seen = flat(harness)
		expect(seen).toContain('Shift+Tab changes the mode')
		expect(seen).toContain('permissions.defaultMode: prompt in ~/.namzu/config.yaml')
		// A pointer someone who installed Namzu can follow, not a path in its source.
		expect(seen).toContain('/permissions explains the modes')
		expect(seen).not.toContain('docs/cli/')
		expect(hasSeenAutoModeDefaultNotice()).toBe(true)
		await sendOne(harness)
		expect(sentMode, 'the first turn runs under auto').toBe('classify')
	})

	it('never shows the notice a second time', async () => {
		const first = await mount()
		await until(() => flat(first).includes(AUTO_MODE_DEFAULT_NOTICE_TITLE))
		first.unmount()
		sessionShown = false

		const second = await mount()
		await until(() => flat(second).includes('auto mode on'))
		await sendOne(second)
		expect(sentMode).toBe('classify')
		expect(flat(second)).not.toContain(AUTO_MODE_DEFAULT_NOTICE_TITLE)
	})

	it('does not show it to a person who has already seen it', async () => {
		markAutoModeDefaultNoticeSeen()
		const harness = await mount()
		await until(() => flat(harness).includes('auto mode on'))
		await sendOne(harness)
		expect(flat(harness)).not.toContain(AUTO_MODE_DEFAULT_NOTICE_TITLE)
	})

	it('starts asking, without a word, when the classifier cannot reach a model', async () => {
		autoModeUsable = false
		const harness = await mount()
		await sendOne(harness)
		expect(sentMode).toBe('prompt')
		expect(flat(harness)).not.toContain('auto mode on')
		expect(flat(harness)).not.toContain(AUTO_MODE_DEFAULT_NOTICE_TITLE)
		expect(flat(harness)).not.toContain('no model to ask in this test')
		expect(hasSeenAutoModeDefaultNotice()).toBe(false)
	})

	it('starts asking when the settings switched auto off', async () => {
		const harness = await mount({ permissionSettings: { disableAutoMode: true } })
		await sendOne(harness)
		expect(sentMode).toBe('prompt')
		expect(hasSeenAutoModeDefaultNotice()).toBe(false)
	})
})

describe('a terminal someone chose a mode for', () => {
	it('keeps a mode named at launch, and shows no notice even when it is auto', async () => {
		const harness = await mount({
			permissionSource: 'launch-flag',
			launchSettings: { permissionMode: 'classify' },
		})
		await until(() => flat(harness).includes('auto mode on'))
		await sendOne(harness)
		expect(sentMode).toBe('classify')
		expect(flat(harness)).not.toContain(AUTO_MODE_DEFAULT_NOTICE_TITLE)
		expect(hasSeenAutoModeDefaultNotice()).toBe(false)
	})

	it('keeps the configured default', async () => {
		const harness = await mount({
			permissionSource: 'config-default',
			launchSettings: { permissionMode: 'prompt' },
			permissionSettings: { defaultMode: 'prompt' },
		})
		await sendOne(harness)
		expect(sentMode).toBe('prompt')
		expect(hasSeenAutoModeDefaultNotice()).toBe(false)
	})

	it('keeps prompt for a launch that was not left to the default', async () => {
		const harness = await mount({ permissionSource: 'default' })
		await sendOne(harness)
		expect(sentMode).toBe('prompt')
	})
})

describe('a turn auto mode stopped for want of a verdict', () => {
	const stop = () =>
		limitHandler?.({
			limit: 'unavailable',
			reason: 'the safety check could not be completed, so the action was not run',
		})

	it('says so in one sentence and leaves auto on for a person who chose it', async () => {
		const harness = await mount({
			permissionSource: 'launch-flag',
			launchSettings: { permissionMode: 'classify' },
		})
		await until(() => flat(harness).includes('auto mode on'))
		await sendOne(harness)
		expect(limitHandler).toBeDefined()
		stop()
		await until(() => flat(harness).includes('could not get a safety decision'))
		expect(AUTO_MODE_STOPPED_NOTICE).toContain('Send a message to try again')
		expect(AUTO_MODE_STOPPED_NOTICE).toContain('Shift+Tab')
		expect(harness.lastFrame() ?? '').toContain('auto mode on')
		await sendOne(harness)
		expect(sentMode, 'the next message is still checked by auto mode').toBe('classify')
	})

	// Nobody picked auto here, so a model that cannot judge must not stop every
	// turn that follows: the terminal asks instead, as at the block limit.
	it('goes back to asking for a terminal that was in auto only by default', async () => {
		const harness = await mount()
		await until(() => flat(harness).includes('auto mode on'))
		await sendOne(harness)
		stop()
		await until(() => flat(harness).includes('This terminal now asks before changes'))
		expect(AUTO_MODE_DEFAULT_STOPPED_NOTICE).toContain('/permissions auto')
		await sendOne(harness)
		expect(sentMode, 'the next message asks before changes').toBe('prompt')
		expect(harness.lastFrame() ?? '').not.toContain('auto mode on')
	})
})

describe('a later session for a terminal in its default', () => {
	it('says in one line when it takes the terminal out of auto', async () => {
		detectedProviders = [DETECTED]
		const harness = await mount()
		await until(() => flat(harness).includes('auto mode on'))
		expect(flat(harness)).not.toContain(AUTO_MODE_DEFAULT_LEFT_NOTICE)
		// Another model whose classifier cannot answer: the default turns to asking.
		autoModeUsable = false
		const before = built
		harness.stdin.write('/model openai/b-model')
		await settle()
		harness.stdin.write('\r')
		await until(() => built > before)
		await until(() => flat(harness).includes(AUTO_MODE_DEFAULT_LEFT_NOTICE))
		await sendOne(harness)
		expect(sentMode).toBe('prompt')
	})
})
