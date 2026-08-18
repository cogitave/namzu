/** `/export` reads durable run evidence, not the transcript `/clear-screen` removes. */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	type Message,
	createAssistantMessage,
	createToolMessage,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
			if (!scope) throw new Error('fixture requires a durable scope')
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
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (
					messages: readonly Message[],
					sendOptions?: SendOptions,
				): AsyncIterable<AgentEvent> {
					const runId = sendOptions?.runId
					if (!runId) throw new Error('App did not reserve a run id')
					const evidencePath = join(
						new DefaultPathBuilder(join(root, '.namzu')).sessionDir(
							scope.projectId,
							scope.sessionId,
						),
						'turns.jsonl',
					)
					const evidence = await readFile(evidencePath, 'utf-8')
					if (!evidence.includes(runId)) throw new Error('run began before its turn binding landed')

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
					const runDir = new DefaultPathBuilder(join(root, '.namzu')).runDir(
						scope.projectId,
						scope.sessionId,
						runId,
					)
					await mkdir(runDir, { recursive: true })
					const events = [
						{ type: 'run_started', runId, seq: 1, timestamp: 1 },
						{
							type: 'message_completed',
							runId,
							seq: 2,
							timestamp: 2,
							iteration: 1,
							messageId: 'msg_clear_export_1',
							stopReason: 'tool_use',
							content: 'First **raw**.',
						},
						{
							type: 'tool_executing',
							runId,
							seq: 3,
							timestamp: 3,
							toolUseId,
							toolName: 'read_file',
							input: { path: 'facts.md' },
						},
						{
							type: 'tool_completed',
							runId,
							seq: 4,
							timestamp: 4,
							toolUseId,
							toolName: 'read_file',
							result: 'durable tool result',
							isError: false,
						},
						{
							type: 'message_completed',
							runId,
							seq: 5,
							timestamp: 5,
							iteration: 2,
							messageId: 'msg_clear_export_2',
							stopReason: 'end_turn',
							content: 'Done.',
						},
						{
							type: 'run_completed',
							runId,
							seq: 6,
							timestamp: 6,
							result: 'First **raw**.Done.',
						},
					]
					await writeFile(
						join(runDir, 'transcript.jsonl'),
						`${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
						'utf-8',
					)
					await writeFile(
						join(runDir, 'messages.json'),
						`${JSON.stringify({
							format: 'namzu.run-message-snapshot.v1',
							throughEventSeq: 6,
							messages: [...messages, first, result, last],
						})}\n`,
						'utf-8',
					)

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
	const started = performance.now()
	while (!(frame() ?? '').includes(text) && performance.now() - started < 4_000) await tick()
	expect(frame()).toContain(text)
}

async function submit(stdin: { write: (text: string) => void }, text: string): Promise<void> {
	stdin.write(text)
	await tick()
	stdin.write('\r')
}

it('exports raw model/tool history after /fork and /clear-screen, then refuses to overwrite it', async () => {
	const ctx: TuiContext = { cwd: root, version: '0.0.0-test' }
	const harness = render(<App ctx={ctx} />)
	mounted = harness
	await waitFor(harness.lastFrame, 'Type a message')
	await tick(100)

	await submit(harness.stdin, 'inspect this')
	await waitFor(harness.lastFrame, 'inspect this')
	await waitFor(harness.lastFrame, 'First')
	await waitFor(harness.lastFrame, 'Type a message')
	await submit(harness.stdin, '/fork')
	await waitFor(harness.lastFrame, 'Forked into')
	await submit(harness.stdin, '/clear-screen')
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
