/** Real tool presenters and event adapter reach the rendered transcript. */

import { afterEach, expect, it, vi } from 'vitest'
import { ToolRegistry, ReadFileTool, GrepTool, JobTool, createToolPresenter, generateRunId, type RunEvent } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
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
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['computer_use'],
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
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				const registry = new ToolRegistry()
				registry.register([ReadFileTool, GrepTool, JobTool])
				const presenter = createToolPresenter(registry)
				const runId = generateRunId()
				const calls = [
					{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence  \nSECOND evidence' },
					{ toolName: 'grep', input: { pattern: 'needle', path: 'src' }, result: 'SEARCH evidence' },
					{ toolName: 'job', input: { action: 'read', id: 'job-one' }, result: 'no new output' },
					{ toolName: 'read', input: { path: 'missing.ts' }, result: 'missing file', isError: true },
				]
				for (const [index, call] of calls.entries()) {
					for (const event of [
						{ type: 'tool_executing', runId, toolUseId: `call-${index}`, toolName: call.toolName, input: call.input },
						{ type: 'tool_completed', runId, toolUseId: `call-${index}`, toolName: call.toolName, result: call.result, isError: call.isError ?? false },
					]) {
						const mapped = actual.toAgentEvent(event as RunEvent, presenter)
						if (mapped) yield mapped
					}
				}
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 120): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

it('groups observations, preserves expandable evidence and distinguishes background output from errors', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	const painted = () => screen.scrollback().join('\n')
	await waitUntil(screen, () => painted().includes('a-model default'))
	screen.press('inspect')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted().includes('failed: missing file'))
	const transcript = painted()
	expect(transcript.match(/Explored/g)).toHaveLength(1)
	expect(transcript).toContain('Read one.ts')
	expect(transcript).toContain('Search needle in src')
	expect(transcript).toContain('Read background output · job-one')
	expect(transcript).toContain('✗ Read missing.ts')
	expect(transcript).not.toContain('FIRST evidence')
	expect(transcript).not.toContain('SEARCH evidence')
	screen.press('\x0f')
	await waitUntil(screen, () => painted().includes('SEARCH evidence'))
	if (painted().includes('Tool output')) {
		screen.press('\x1b[D')
		await waitUntil(screen, () => painted().includes('SECOND evidence'))
		screen.press('\x1b[D')
		await waitUntil(screen, () => painted().includes('FIRST evidence'))
	}
	expect(painted().match(/FIRST evidence/g)).toHaveLength(1)
})
