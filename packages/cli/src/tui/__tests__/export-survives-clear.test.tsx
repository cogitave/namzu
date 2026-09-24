/** `/export` reads the session log, not the transcript `/clear-screen` removes. */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	createAssistantMessage,
	createToolMessage,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type {
	AgentEvent,
	AgentSession,
	AgentSessionOptions,
	SendOptions,
} from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
let root = ''

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (
			_preferences: Preferences,
			_detected: readonly unknown[],
			options: AgentSessionOptions,
		): Promise<AgentSession> => {
			const scope = options.scope
			const sessions = options.conversationSessions
			if (!scope || !sessions) throw new Error('fixture requires a durable conversation')
			return {
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
				resumeDurable: async () => {
					throw new Error('not used')
				},
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
				},
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (
					messages: readonly Message[],
					sendOptions?: SendOptions,
				): AsyncIterable<AgentEvent> {
					if (!sendOptions?.turnId) throw new Error('App did not reserve a turn id')
					const toolUseId = 'toolu_clear_export'
					const first = createAssistantMessage('First **raw**.', [
						{
							id: toolUseId,
							type: 'function',
							function: { name: 'read_file', arguments: '{"path":"facts.md"}' },
						},
					])
					const result = createToolMessage('durable tool result', toolUseId)
					const last = createAssistantMessage('Done.')
					// What the kernel's recorder appends while the turn runs.
					const user = messages.at(-1)
					if (!user) throw new Error('App sent no prompt')
					await recordTurn(sessions, scope.sessionId, [user, first, result, last], {
						turnId: sendOptions.turnId,
					})

					yield { kind: 'delta', text: 'First **raw**.' }
					yield { kind: 'delta', text: 'Done.' }
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}
		},
	}
})

const { App } = await import('../App.js')
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
// A full-package run exercises several mounted Ink applications concurrently.
// Wait on observable ownership instead of making a four-second CPU-load claim.
const RENDER_WAIT_MS = 10_000
let mounted: { unmount: () => void } | undefined

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-export-after-clear-'))
})

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
	vi.restoreAllMocks()
	removeTempDir(root)
})

async function waitFor(frame: () => string | undefined, text: string): Promise<void> {
	await vi.waitFor(() => expect(frame()).toContain(text), RENDER_WAIT_MS)
}

async function submit(stdin: { write: (text: string) => void }, text: string): Promise<void> {
	stdin.write(text)
	await tick()
	stdin.write('\r')
}

async function waitForComposerInput(harness: {
	readonly stdin: { write: (text: string) => void }
	lastFrame(): string | undefined
}): Promise<void> {
	const probe = 'composer-ready-probe'
	await vi.waitFor(async () => {
		harness.stdin.write(probe)
		await tick(250)
		expect(harness.lastFrame()).toContain(probe)
	}, RENDER_WAIT_MS)
	// Ctrl+U clears every probe, including repeats sent before a busy render
	// made the first accepted one visible.
	harness.stdin.write('\u0015')
	await waitFor(harness.lastFrame, 'Type a message')
}

it('exports raw model/tool history after /fork and /clear-screen, then refuses to overwrite it', async () => {
	const ctx: TuiContext = { cwd: root, version: '0.0.0-test' }
	const harness = render(<App ctx={ctx} />)
	mounted = harness
	await waitFor(harness.lastFrame, 'Type a message')
	// The ready frame can paint before Ink replaces the disabled input
	// subscription from the preceding boot render. Prove the composer owns
	// input instead of guessing how long that effect takes on a loaded runner.
	await waitForComposerInput(harness)

	await submit(harness.stdin, 'inspect this')
	await waitFor(harness.lastFrame, 'inspect this')
	await waitFor(harness.lastFrame, 'First')
	await waitFor(harness.lastFrame, 'Type a message')
	await submit(harness.stdin, '/fork')
	await waitFor(harness.lastFrame, 'Forked into')
	harness.stdin.write('\x0c')
	await tick(80)
	expect(harness.lastFrame()).not.toContain('First **raw**.')

	const target = join(root, 'conversation.md')
	await submit(harness.stdin, `/export ${target}`)
	await waitFor(harness.lastFrame, 'Exported 1 turn')
	const markdown = await readFile(target, 'utf-8')
	expect(markdown).toContain('First **raw**.')
	expect(markdown).toContain('`read_file`')
	expect(markdown).toContain('facts.md')
	expect(markdown).toContain('durable tool result')

	await submit(harness.stdin, `/export ${target}`)
	await waitFor(harness.lastFrame, 'nothing was overwritten')
	expect(await readFile(target, 'utf-8')).toBe(markdown)
})
