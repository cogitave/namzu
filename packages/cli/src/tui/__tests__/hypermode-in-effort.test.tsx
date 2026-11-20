/**
 * Hypermode is an option of the effort command, for this conversation: any level can carry it, the
 * footer names it after the effort, and it is refused with one plain sentence while dynamic
 * workflows are off. A saved `hypermode: true` starts a conversation in it only while workflows are
 * on, and says why once when they are not.
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

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const REFUSAL =
	'Hypermode needs dynamic workflows, and they are off. Turn them on in Settings (Dynamic workflows) first.'
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	vi.stubEnv('FORCE_COLOR', '0')
	vi.stubEnv('TERM', 'xterm-256color')
})
afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

/** The visible text with each wrapped line joined, so a sentence the box broke still reads as one. */
const screen = (harness: { lastFrame: () => string | undefined }) =>
	(harness.lastFrame() ?? '')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes
		.replace(/\u001b\[[0-9;]*m/g, '')
		.replace(/\s+/g, ' ')

async function start(ctx: TuiContext) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(screen(harness)).toContain('a-model'))
	return harness
}

async function run(harness: Awaited<ReturnType<typeof start>>, command: string) {
	for (const char of command) harness.stdin.write(char)
	await vi.waitFor(() => expect(screen(harness)).toContain(command))
	harness.stdin.write('\r')
}

it('turns hypermode on with a level, names it once on the frame, and never saves it', async () => {
	const harness = await start({ cwd: '/w', version: '0.0.0-test' })
	await run(harness, '/effort high hypermode on')
	await vi.waitFor(() => expect(screen(harness)).toContain('Hypermode is on for this conversation'))
	// The label is the frame's alone: no `· hypermode` after the effort in the status line.
	const lines = (harness.lastFrame() ?? '').split('\n')
	const framed = lines.filter((l) => /\bhypermode\b/.test(l) && /─/.test(l))
	expect(framed).toHaveLength(1)
	expect(screen(harness)).not.toContain('· hypermode')
	expect(screen(harness)).toContain('effort high')
})

it('turns hypermode on and off by itself, leaving the level', async () => {
	const harness = await start({ cwd: '/w', version: '0.0.0-test' })
	await run(harness, '/effort hypermode on')
	await vi.waitFor(() => expect(screen(harness)).toContain('hypermode'))
	await run(harness, '/effort hypermode off')
	await vi.waitFor(() => expect(screen(harness)).toContain('Hypermode is off'))
})

it('refuses the option, in one sentence, while dynamic workflows are off', async () => {
	const harness = await start({ cwd: '/w', version: '0.0.0-test', workflow: { enabled: false } })
	await run(harness, '/effort high hypermode on')
	await vi.waitFor(() => expect(screen(harness)).toContain(REFUSAL))
	expect(screen(harness)).not.toContain('hypermode ─')
	expect(screen(harness)).not.toContain('Hypermode is on')
})

it('does not start a conversation in the saved mode while workflows are off, and says why once', async () => {
	const harness = await start({
		cwd: '/w',
		version: '0.0.0-test',
		hypermode: true,
		workflow: { enabled: false },
	})
	await vi.waitFor(() => expect(screen(harness)).toContain(REFUSAL))
	expect(screen(harness)).not.toContain('· hypermode')
})

it('starts a conversation in the saved mode while workflows are on', async () => {
	const harness = await start({ cwd: '/w', version: '0.0.0-test', hypermode: true })
	await vi.waitFor(() => expect(screen(harness)).toContain('hypermode'))
	expect(screen(harness)).not.toContain(REFUSAL)
})
