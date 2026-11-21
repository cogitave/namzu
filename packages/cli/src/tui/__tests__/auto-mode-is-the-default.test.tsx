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

import { rmSync } from 'node:fs'

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
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

const { App, AUTO_MODE_STOPPED_NOTICE } = await import('../App.js')

const base: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
	permissionSource: 'auto-default',
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => rmSync(acknowledgementsPath(), { force: true }))
afterEach(() => {
	autoModeUsable = true
	sentMode = undefined
	limitHandler = undefined
	turnsSent = 0
	sessionShown = false
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
		expect(seen).toContain('Press Shift+Tab to change the mode')
		expect(seen).toContain('permissions.defaultMode: prompt in ~/.namzu/config.yaml')
		expect(seen).toContain('docs/cli/permission-modes.md')
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
	it('says so in one sentence and leaves the mode on auto', async () => {
		const harness = await mount()
		await until(() => flat(harness).includes('auto mode on'))
		await sendOne(harness)
		expect(limitHandler).toBeDefined()
		limitHandler?.({
			limit: 'unavailable',
			reason: 'the safety check could not be completed, so the action was not run',
		})
		await until(() => flat(harness).includes('could not get a safety decision'))
		expect(AUTO_MODE_STOPPED_NOTICE).toContain('Send a message to try again')
		expect(AUTO_MODE_STOPPED_NOTICE).toContain('Shift+Tab')
		expect(harness.lastFrame() ?? '').toContain('auto mode on')
		await sendOne(harness)
		expect(sentMode, 'the next message is still checked by auto mode').toBe('classify')
	})
})
