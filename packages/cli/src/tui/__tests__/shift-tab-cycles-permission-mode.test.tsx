/**
 * Shift+Tab reaches the permission mode, and the mode reaches the screen.
 *
 * `/permissions accept-edits` already worked through the chooser; the key is
 * the reflex path, and a key that is bound in `Composer` but never wired from
 * `App` is a key that does nothing while the hint says otherwise. So this
 * drives a rendered `<App>`: the mode line is absent under `prompt`, appears
 * after Shift+Tab, names the key, and leaves after a second press.
 *
 * The footer is the key's only reply. Every press used to append
 * "Permissions: <mode> for this conversation. …" to the transcript, so five presses
 * left five lines; the reference terminal rewrites its footer and writes
 * nothing. And the key works while a turn runs: it used to be refused there
 * with "Permissions were not changed. Finish or stop the current work first."
 */

import { rmSync } from 'node:fs'

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import {
	acknowledgeBypass,
	acknowledgementsPath,
	hasAcknowledgedBypass,
} from '../../permissions/consent.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

/** Holds the turn open until the test releases it. */
let releaseTurn: (() => void) | null = null
let holdTurn = false
/** What the running turn would read at its next decision. */
let readMode: (() => string) | undefined
const recorded: string[] = []
/** Whether the mocked session can run the auto mode's classifier. */
let autoModeUsable = false
/** The callback the turn hands the kernel for a classifier that stopped being trusted. */
let limitHandler: ((event: { limit: 'consecutive' | 'total'; reason: string }) => void) | undefined

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
			autoMode: autoModeUsable
				? { available: true }
				: { available: false, reason: 'Auto mode has no model to ask in this test.' },
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
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
			setPermissionMode: async (mode: string) => {
				recorded.push(mode)
			},
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				readMode = opts?.currentPermissionMode as (() => string) | undefined
				limitHandler = opts?.onAutoModeLimit
				if (holdTurn) {
					await new Promise<void>((resolve) => {
						releaseTurn = resolve
					})
				}
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
// The acknowledgement lives in the suite's home, which every test here shares.
beforeEach(() => rmSync(acknowledgementsPath(), { force: true }))
afterEach(() => {
	releaseTurn?.()
	releaseTurn = null
	holdTurn = false
	readMode = undefined
	autoModeUsable = false
	limitHandler = undefined
	recorded.length = 0
	for (const m of mounted.splice(0)) m.unmount()
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The escape sequence a terminal sends for Shift+Tab. */
const SHIFT_TAB = '\u001b[Z'

async function frameShows(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if ((read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`no frame showed ${JSON.stringify(needle)} within ${budgetMs}ms`)
}

async function frameStopsShowing(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (!(read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`${JSON.stringify(needle)} still on screen after ${budgetMs}ms`)
}

describe('Shift+Tab in the composer', () => {
	it('turns accept-edits on, says so beside the input, and turns it off again', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		expect(harness.lastFrame() ?? '', 'the default mode draws no line').not.toContain(
			'⏵⏵ accept edits on',
		)

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ accept edits on')
		expect(harness.lastFrame() ?? '').toContain('shift+tab to cycle')

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '‖ plan mode on')

		harness.stdin.write(SHIFT_TAB)
		await frameStopsShowing(harness.lastFrame, '‖ plan mode on')
		expect(harness.lastFrame() ?? '').not.toContain('⏵⏵ accept edits on')
	})

	it('writes nothing to the transcript, however many times it is pressed', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		const before = harness.frames.length
		for (let i = 0; i < 5; i++) {
			harness.stdin.write(SHIFT_TAB)
			await tick(40)
		}
		await frameShows(harness.lastFrame, '‖ plan mode on')
		const seen = harness.frames.slice(before).join('\n')
		expect(seen).not.toContain('Permissions:')
		expect(seen).not.toContain('for this conversation')
		expect(seen).not.toContain('⏸')
		// Five presses from `prompt`, each one recorded and none of them printed.
		expect(recorded).toEqual(['accept-edits', 'plan', 'prompt', 'accept-edits', 'plan'])
	})

	it('changes the mode while a turn runs, and the running turn reads the new one', async () => {
		holdTurn = true
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		for (let waited = 0; releaseTurn === null && waited < 4000; waited += 20) await tick(20)
		expect(releaseTurn, 'the turn is running').not.toBeNull()
		expect(readMode?.(), 'the turn starts under the mode it was sent with').toBe('prompt')

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ accept edits on')
		expect(readMode?.(), 'the next decision of this same turn sees the change').toBe('accept-edits')
		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '‖ plan mode on')
		expect(readMode?.()).toBe('plan')
		expect(recorded, 'each change is recorded for the running turn').toEqual([
			'accept-edits',
			'plan',
		])
		expect(harness.lastFrame() ?? '').not.toContain('Permissions were not changed')
		expect(harness.lastFrame() ?? '').not.toContain('Permissions:')

		releaseTurn?.()
		await tick(200)
		expect(harness.lastFrame() ?? '', 'the mode outlives the turn it was changed in').toContain(
			'‖ plan mode on',
		)
	})

	it('does not queue or submit the draft the way plain Tab would', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)

		harness.stdin.write('half a thought')
		await tick(20)
		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ accept edits on')

		expect(harness.lastFrame() ?? '', 'the draft is still in the composer').toContain(
			'half a thought',
		)
		expect(harness.lastFrame() ?? '').not.toContain('queued')
	})
})

/** Presses Shift+Tab `count` times, waiting for each change to be recorded. */
async function press(harness: ReturnType<typeof render>, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const before = recorded.length
		harness.stdin.write(SHIFT_TAB)
		await vi.waitFor(() => expect(recorded).toHaveLength(before + 1))
	}
}

async function mountReady(extra: Partial<TuiContext> = {}) {
	const harness = render(<App ctx={{ ...ctx, ...extra }} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Type a message'))
	return harness
}

describe('Shift+Tab and the two modes that stop asking', () => {
	it('stays on three stops when neither bypass nor auto can be reached', async () => {
		const harness = await mountReady()
		await press(harness, 4)
		expect(recorded).toEqual(['accept-edits', 'plan', 'prompt', 'accept-edits'])
		expect(harness.frames.join('\n')).not.toContain('bypass permissions on')
		expect(harness.frames.join('\n')).not.toContain('auto mode on')
	})

	it('reaches auto after plan from an ordinary launch when a classifier can be asked', async () => {
		autoModeUsable = true
		const harness = await mountReady()
		await press(harness, 4)
		expect(recorded).toEqual(['accept-edits', 'plan', 'classify', 'prompt'])
		await vi.waitFor(() => expect(harness.frames.join('\n')).toContain('⏵⏵ auto mode on'))
		expect(harness.frames.join('\n'), 'the first entry says what auto does, once').toContain(
			'a second model checks each call',
		)
	})

	it('never reaches bypass or auto when the settings switched auto off and nothing opened bypass', async () => {
		autoModeUsable = true
		const harness = await mountReady({
			permissionSettings: { disableAutoMode: true },
		})
		await press(harness, 4)
		expect(recorded).toEqual(['accept-edits', 'plan', 'prompt', 'accept-edits'])
	})

	describe('once bypass has been acknowledged', () => {
		it('puts bypass, then auto, between plan and prompt', async () => {
			acknowledgeBypass()
			autoModeUsable = true
			const harness = await mountReady({ allowDangerouslySkipPermissions: true })
			await press(harness, 5)
			expect(recorded).toEqual(['accept-edits', 'plan', 'bypass', 'classify', 'prompt'])
			await vi.waitFor(() =>
				expect(harness.frames.join('\n')).toContain('⏵⏵ bypass permissions on'),
			)
		})

		it('keeps both in the cycle after --yolo once the key has left them', async () => {
			acknowledgeBypass()
			autoModeUsable = true
			const harness = await mountReady({ skipPermissions: true })
			await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('bypass permissions on'))
			await tick(60)
			await press(harness, 6)
			// bypass -> auto -> prompt -> accept-edits -> plan -> bypass -> auto
			expect(recorded).toEqual(['classify', 'prompt', 'accept-edits', 'plan', 'bypass', 'classify'])
		})

		it('goes from bypass straight to prompt when auto is not available', async () => {
			acknowledgeBypass()
			const harness = await mountReady({ skipPermissions: true })
			await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('bypass permissions on'))
			await tick(60)
			await press(harness, 1)
			expect(recorded).toEqual(['prompt'])
		})

		it('refuses to switch to bypass by name when the launch did not open it', async () => {
			acknowledgeBypass()
			const harness = await mountReady()
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() =>
				expect(harness.frames.join('\n')).toContain('Bypass mode is not available'),
			)
			expect(recorded).toEqual([])
		})

		it('refuses bypass when permissions.disableBypassMode closed it, even after a flag', async () => {
			acknowledgeBypass()
			const harness = await mountReady({
				allowDangerouslySkipPermissions: true,
				bypassAvailable: false,
				permissionSettings: { disableBypassMode: true },
			})
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() =>
				expect(harness.frames.join('\n')).toContain('Bypass mode is not available'),
			)
			expect(recorded).toEqual([])
		})

		it('switches to bypass by name when the launch opened it', async () => {
			acknowledgeBypass()
			const harness = await mountReady({ allowDangerouslySkipPermissions: true })
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() => expect(recorded).toEqual(['bypass']))
		})

		it('says why auto cannot be entered, and stays where it was', async () => {
			const harness = await mountReady()
			harness.stdin.write('/permissions auto')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() =>
				expect(harness.frames.join('\n')).toContain('no model to ask in this test'),
			)
			expect(recorded).toEqual([])
		})
	})

	describe('the first switch into bypass', () => {
		it('asks once, remembers a yes, and does not ask again', async () => {
			expect(hasAcknowledgedBypass()).toBe(false)
			const harness = await mountReady({ allowDangerouslySkipPermissions: true })
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Run without asking?'))
			expect(recorded, 'nothing changes while the question is open').toEqual([])
			harness.stdin.write('\u001b[B')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() => expect(recorded).toEqual(['bypass']))
			expect(hasAcknowledgedBypass()).toBe(true)

			// Leave and come back: no second question.
			await press(harness, 1)
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() => expect(recorded).toEqual(['bypass', 'prompt', 'bypass']))
			expect(harness.frames.slice(-3).join('\n')).not.toContain('Run without asking?')
		})

		it('stays in the current mode when the answer is no, and asks again next time', async () => {
			const harness = await mountReady({ allowDangerouslySkipPermissions: true })
			harness.stdin.write('/permissions bypass')
			await tick(30)
			harness.stdin.write('\r')
			await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Run without asking?'))
			harness.stdin.write('\r')
			await tick(100)
			expect(recorded).toEqual([])
			expect(hasAcknowledgedBypass()).toBe(false)
		})
	})

	it('drops to prompt, with the reason in the transcript, when the classifier stops being trusted', async () => {
		autoModeUsable = true
		const harness = await mountReady()
		harness.stdin.write('/permissions auto')
		await tick(30)
		harness.stdin.write('\r')
		await vi.waitFor(() => expect(recorded).toEqual(['classify']))
		harness.stdin.write('hello')
		await tick(20)
		harness.stdin.write('\r')
		await vi.waitFor(() => expect(limitHandler).toBeDefined())
		limitHandler?.({ limit: 'consecutive', reason: 'It tried to publish the package.' })
		await vi.waitFor(() => expect(recorded).toEqual(['classify', 'prompt']))
		await vi.waitFor(() => {
			const seen = (harness.lastFrame() ?? '').replace(/\s+/g, ' ')
			expect(seen).toContain('blocked three actions in a row')
			expect(seen).toContain('ask before changes again')
			expect(seen).toContain('It tried to publish the package.')
			expect(seen, 'the footer follows').not.toContain('auto mode on')
		})
	})
})
