/** Real tool presenters and event adapter reach the rendered transcript. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	EditTool,
	type SessionEvent,
	ToolManager,
	WriteFileTool,
	createToolPresenter,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { testToolset } from '../../test-support/toolset.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

/** The real tools run first, against a real folder, so the screen is fed real facts. */
const { dir, edit, created } = await (async () => {
	const dir = mkdtempSync(join(tmpdir(), 'edit-diff-app-'))
	mkdirSync(dir, { recursive: true })
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
	writeFileSync(join(dir, 'a.ts'), `${lines.join('\n')}\n`)
	const context = {
		workingDirectory: dir,
		env: {},
		abortSignal: new AbortController().signal,
	}
	const edit = await EditTool.execute(
		{
			path: 'a.ts',
			edits: [
				{ old_string: 'line 3\n', new_string: 'three\n' },
				{ old_string: 'line 25\n', new_string: 'twenty-five\n' },
			],
		} as never,
		context as never,
	)
	const created = await WriteFileTool.execute(
		{ path: 'n.txt', content: `${lines.join('\n')}\n` } as never,
		context as never,
	)
	return { dir, edit, created }
})()

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
			toolNames: () => ['edit', 'write'],
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
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				const registry = new ToolManager({
					toolsets: [testToolset(...[EditTool, WriteFileTool])],
					messages: () => [],
				})
				const presenter = createToolPresenter(registry)
				const turnId = generateTurnId()
				const calls = [
					{ toolName: 'edit', input: { path: 'a.ts', edits: [] }, result: edit },
					{ toolName: 'write', input: { path: 'n.txt' }, result: created },
				]
				for (const [index, call] of calls.entries()) {
					for (const event of [
						{
							type: 'tool_executing',
							turnId,
							toolUseId: `call-${index}`,
							toolName: call.toolName,
							input: call.input,
						},
						{
							type: 'tool_completed',
							turnId,
							toolUseId: `call-${index}`,
							toolName: call.toolName,
							result: call.result.output,
							isError: !call.result.success,
							facts: call.result.facts,
							durationMs: 12,
						},
					]) {
						const mapped = actual.toAgentEvent(
							event as unknown as SessionEvent,
							presenter,
							undefined,
							dir,
						)
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

it('draws an edit as counted hunks and a created file as its first ten lines', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 60, scrollback: 300 })
	mounted = screen
	const painted = () => screen.scrollback().join('\n')
	await waitUntil(screen, () => painted().includes('a-model'))
	screen.press('change')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted().includes('Wrote 30 lines to n.txt'), 1500)
	const transcript = painted()
	// The counts are the whole file's: two lines changed far apart.
	expect(transcript).toContain('Added 2 lines, removed 2 lines')
	// One shape for a settled row, and no duration for a step that took 12 ms.
	expect(transcript).toContain('● Update(a.ts)')
	expect(transcript).toContain('● Write(n.txt)')
	expect(transcript).not.toMatch(/Update\(a\.ts\) · /u)
	// Hunks: gutter, the marker straight before the code, context, and a gap between the two hunks.
	expect(transcript).toMatch(/ 3 -line 3/u)
	expect(transcript).toMatch(/ 3 \+three/u)
	expect(transcript).toMatch(/ 6 {2}line 6/u)
	expect(transcript).toMatch(/^\s*\.\.\.$/mu)
	// No rule beside the body, and the call row does not repeat the change above its result.
	expect(transcript).not.toContain('▏')
	// A created file shows ten lines as they are, then the one folding phrase.
	expect(transcript).toMatch(/^\s*line 10$/mu)
	expect(transcript).not.toMatch(/^\s*line 11$/mu)
	expect(transcript).toContain('… +20 lines (ctrl+o to expand)')
})
