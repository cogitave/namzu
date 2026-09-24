/**
 * `toolResultScreens` reaches the interactive session, from the config file.
 *
 * Every other CLI surface passes the key to `createAgentSession` — headless
 * `exec`, `exec --json`, `drain`, ACP and the resident step — and each of those
 * was written by hand, in a command that already had the config in scope. The
 * TUI has to carry it the long way: `cli.ts` builds a `TuiContext`, the App
 * holds it, and `hydrateSession` is the only place in the TUI that constructs
 * a session. Both of those hops dropped the key, so the surface most people
 * use was the one surface where an operator's "[]" meant nothing.
 *
 * `tool-result-screens-reach-the-turn` proves the third hop — session options
 * to the registry the turn runs with — by driving `createAgentSession`
 * directly, which is exactly why it stayed green while this was broken. This
 * test drives the two hops above it: the real `runCli` (with only the TUI
 * entry mocked, so the config really is read and `buildTuiContext` really is
 * called), then the real `App` (with only `createAgentSession` mocked, so
 * `hydrateSession` really is the code under test).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
vi.mock('../index.js', () => ({ launchTui }))

/** Every options object the App passed to `createAgentSession`. */
const sessionOptions: Record<string, unknown>[] = []

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
// Only the network call, not the module: `cli.ts` reads more of it than the
// App does, and a wholesale replacement is a mock that fails on an export it
// was never told about.
vi.mock('../../integrations/updates.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/updates.js')>()),
	checkUpdates: async () => [],
}))
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

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (
			_prefs: unknown,
			_detected: unknown,
			options: Record<string, unknown>,
		): Promise<AgentSession> => {
			sessionOptions.push(options)
			return {
				hasProvider: true,
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
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (): AsyncIterable<AgentEvent> {
					yield { kind: 'done' } as AgentEvent
				},
			}
		},
	}
})

const { runCli } = await import('../../cli.js')
const { App } = await import('../App.js')

const roots: string[] = []
const mounted: Array<{ unmount: () => void }> = []
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	sessionOptions.length = 0
	launchTui.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	for (const root of roots.splice(0)) removeTempDir(root)
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A config file, a TTY, and the context `cli.ts` hands the TUI. */
async function launchContext(config: unknown): Promise<TuiContext> {
	const root = mkdtempSync(join(tmpdir(), 'namzu-screens-tui-'))
	roots.push(root)
	const home = join(root, 'home')
	const cwd = join(root, 'workspace')
	mkdirSync(home)
	mkdirSync(cwd)
	vi.stubEnv('NAMZU_HOME', home)
	vi.spyOn(process, 'cwd').mockReturnValue(cwd)
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
	writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(config))
	await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)
	expect(launchTui).toHaveBeenCalledOnce()
	return launchTui.mock.calls[0]![0]
}

/** What the App hands `createAgentSession`, from the context the CLI built. */
async function sessionOptionsFor(config: unknown): Promise<Record<string, unknown>> {
	const ctx = await launchContext(config)
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	const deadline = Date.now() + 4000
	while (Date.now() < deadline && sessionOptions.length === 0) await tick(20)
	const options = sessionOptions[0]
	if (!options) throw new Error('the App never created a session')
	return options
}

describe('toolResultScreens from the config file', () => {
	it.each([
		[
			'an empty list, which is the off switch',
			{ toolResultScreens: [] },
			[] as readonly unknown[],
		],
		[
			'a list of names',
			{ toolResultScreens: ['injection', 'correspondence'] },
			['injection', 'correspondence'],
		],
		[
			'an entry carrying the screen options',
			{ toolResultScreens: [{ name: 'correspondence', passthroughTools: ['mcp_login-echo_echo'] }] },
			[{ name: 'correspondence', passthroughTools: ['mcp_login-echo_echo'] }],
		],
	])('reaches the interactive session: %s', async (_label, config, expected) => {
		const options = await sessionOptionsFor(config)

		// Identity, not merely presence. `[]` in particular has to stay `[]`
		// all the way down: a truthiness test at either hop would turn the
		// operator's off switch into the kernel's default, which is the
		// opposite of what they asked for.
		expect(options.toolResultScreens).toEqual(expected)
	})

	it('stays absent when the config file says nothing, so the kernel default stands', async () => {
		const options = await sessionOptionsFor({})

		expect(options).not.toHaveProperty('toolResultScreens')
	})
})
