/**
 * `←` on an empty message box in a whole App: it asks for the workspaces screen when the host has
 * one, says so in the footer when that cannot open, and never opens the workflow view.
 */

import { createRequire } from 'node:module'

import { render } from 'ink-testing-library'
import type React from 'react'
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

async function start(ctx: TuiContext, props: Partial<React.ComponentProps<typeof App>> = {}) {
	const harness = render(<App ctx={ctx} {...props} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(screen(harness)).toContain('a-model'))
	return harness
}

const LEFT = '\u001b[D'

it('asks the host for the workspaces screen and opens nothing else', async () => {
	const open = vi.fn(async () => true)
	const harness = await start({ cwd: '/w', version: '0.0.0-test' }, { onOpenWorkspaces: open })
	harness.stdin.write(LEFT)
	await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
	expect(screen(harness)).not.toContain('Workspaces cannot open')
})

it('says in the footer when the workspaces screen cannot open, and does not open the workflow view', async () => {
	const open = vi.fn(async () => false)
	const harness = await start({ cwd: '/w', version: '0.0.0-test' }, { onOpenWorkspaces: open })
	harness.stdin.write(LEFT)
	await vi.waitFor(() =>
		expect(screen(harness)).toContain('Workspaces cannot open in this terminal'),
	)
	expect(screen(harness)).not.toContain('Workflows')
	expect(screen(harness)).toContain('Type a message')
})

it('does nothing while idle where the host has no workspaces screen', async () => {
	const harness = await start({ cwd: '/w', version: '0.0.0-test' })
	const before = screen(harness)
	harness.stdin.write(LEFT)
	await new Promise((resolve) => setImmediate(resolve))
	expect(screen(harness)).toBe(before)
	expect(screen(harness)).not.toContain('Press ← again')
})
