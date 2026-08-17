/**
 * Ctrl+V reports its outcome, including the outcomes that are not an image.
 *
 * The status bar advertises `Ctrl+V to attach`. The handler read the clipboard,
 * attached an image if it found one, and otherwise did nothing at all — no
 * chip, no message, no error. So "you have not copied an image", "this machine
 * has no clipboard tool installed", and "this key was never wired up" were the
 * same observable event, and the operator's next move is different in each.
 *
 * These drive a rendered `<App>` rather than the component alone, because the
 * composer has no transcript of its own: whether the reason reaches the screen
 * depends on the caller passing `onNotice`, which a component test cannot see.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** What the mocked clipboard returns for the next read. */
let clipboard: import('../../integrations/clipboard/image.js').ClipboardRead = { kind: 'empty' }

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => clipboard,
}))

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
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
			providerSummary: 'a-provider',
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
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

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
	clipboard = { kind: 'empty' }
})

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function ready() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	return harness
}

describe('Ctrl+V with nothing to paste', () => {
	it('says the clipboard holds no image, rather than doing nothing', async () => {
		clipboard = { kind: 'empty' }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16') // Ctrl+V
		await frameShows(lastFrame, 'No image on the clipboard')

		expect(lastFrame(), 'the key was silent').toContain('No image on the clipboard')
	})

	it('names what is missing when the machine cannot read the clipboard at all', async () => {
		// A different situation with a different fix, so it gets a different
		// sentence: nothing the operator copies will help until a tool exists.
		clipboard = { kind: 'unavailable', detail: 'install xclip (X11) or wl-clipboard (Wayland)' }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16')
		await frameShows(lastFrame, 'Cannot read images')

		const frame = lastFrame() ?? ''
		expect(frame).toContain('Cannot read images')
		expect(frame, 'did not say what to install').toContain('xclip')
		expect(frame, 'blamed an empty clipboard for a missing tool').not.toContain(
			'No image on the clipboard',
		)
	})
})

describe('Ctrl+V with an image', () => {
	it('attaches it and says nothing, because the chip is the report', async () => {
		clipboard = { kind: 'image', image: { data: 'AAAA', mediaType: 'image/png' } }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16')
		await frameShows(lastFrame, 'Image #1')

		const frame = lastFrame() ?? ''
		expect(frame).toContain('Image #1')
		expect(frame, 'reported a failure on the success path').not.toContain('No image')
	})
})
