/**
 * The boot screen and the ready transcript must not each publish the banner.
 *
 * Ink's live region is terminal output, not a virtual DOM that disappears
 * without a trace. Moving the same banner from a live pre-ready branch into
 * Transcript's Static header printed both copies to real scrollback even
 * though component snapshots only showed the current one. This drives the PTY
 * boundary where the duplicate was visible to an operator.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const boot = vi.hoisted(() => {
	let release: (() => void) | undefined
	const ready = new Promise<void>((resolve) => {
		release = resolve
	})
	return { ready, release: () => release?.() }
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
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
		createAgentSession: async (): Promise<AgentSession> => {
			await boot.ready
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				providerSummary: 'OpenAI (Codex subscription)',
				modelSummary: 'gpt-test',
				toolNames: () => [],
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				approvalLatched: () => false,
				promptExemptTools: () => [],
				compact: async () => null,
				resumeDurable: async () => {
					throw new Error('not used by the boot test')
				},
				close: async () => {},
				send: async function* () {},
			}
		},
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 80): Promise<void> {
	for (let i = 0; i < attempts && !predicate(); i++) await screen.waitForRender()
	expect(predicate()).toBe(true)
}

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

it('keeps one banner through readiness and the full subscription login frame', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 100,
		rows: 24,
	})
	mounted = screen

	await screen.waitForRender()
	expect(painted(screen)).not.toContain('Cogitave v0.0.0-test')

	boot.release()
	await waitUntil(screen, () => painted(screen).includes('Connected to OpenAI'))

	const output = painted(screen)
	expect(output.match(/Cogitave v0\.0\.0-test/g)).toHaveLength(1)
	expect(output).not.toContain('● idle')
	expect(output).not.toContain('Esc×2 edit previous')
	expect(output).not.toContain('Ctrl+C ×2 to exit')
	expect(output).toContain('/help')

	// The real authorization address is long enough to push this 24-row terminal
	// into Ink's full-frame path. A range-resolved renderer once treated that
	// layout as effectively unbounded and allocated until OOM; replaying Static
	// output there also exposed duplicate banners on real terminals.
	screen.press('/login')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Choose a subscription session'))
	screen.press('\r')
	await waitUntil(screen, () => painted(screen).includes('Complete Anthropic (Claude) sign-in'))

	const loginOutput = painted(screen)
	expect(loginOutput).toContain('/oauth/authorize')
	expect(loginOutput.match(/Cogitave v0\.0\.0-test/g)).toHaveLength(1)
})
