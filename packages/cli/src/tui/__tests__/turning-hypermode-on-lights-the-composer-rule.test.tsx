/**
 * The glow on the composer's upper rule plays when the session mode is turned
 * on (`/hypermode`), not when the word is merely typed: a typed word only arms
 * for one message. It is drawn from the theme's glow tokens and it is motion, so
 * reduced motion keeps the rule plain.
 */

import { createRequire } from 'node:module'

import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

vi.mock('ink', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ink')>()
	return {
		...actual,
		useStdout: () => {
			const real = actual.useStdout()
			return { ...real, stdout: Object.assign(Object.create(real.stdout), { isTTY: true }) }
		},
	}
})

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

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			reasoningEffortLevels: ['low', 'medium', 'high'],
			toolNames: () => [],
			presenter: genericPresenter,
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
			resumePaused: () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			setPermissionMode: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const { setReducedMotion } = await import('../motion.js')
const { resetThemeStore } = await import('../theme-store.js')

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []
/** The dark theme's lightest and deepest glow steps; its middle one is also the mode word's own colour. */
const GLOW = ['38;5;183m', '38;5;97m']

beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
})
afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	setReducedMotion(false)
	resetThemeStore()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

async function runHypermode(typed: string) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('a-model'))
	const before = harness.frames.length
	harness.stdin.write(typed)
	await tick()
	harness.stdin.write('\r')
	return { harness, before }
}

const glowIn = (frames: readonly string[]) => frames.some((f) => GLOW.some((code) => f.includes(code)))

it('plays when /hypermode turns the session mode on, in the theme glow colours', async () => {
	const { harness, before } = await runHypermode('/hypermode')
	await vi.waitFor(() => expect(glowIn(harness.frames.slice(before))).toBe(true))
	expect(harness.lastFrame() ?? '').toContain('hypermode')
})

it('does not play for the word typed into a message', async () => {
	const { harness, before } = await runHypermode('hypermode')
	await tick(120)
	expect(glowIn(harness.frames.slice(before))).toBe(false)
})

it('keeps the rule plain under reduced motion', async () => {
	setReducedMotion(true)
	const { harness, before } = await runHypermode('/hypermode')
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('hypermode'))
	await tick(120)
	expect(glowIn(harness.frames.slice(before))).toBe(false)
})
