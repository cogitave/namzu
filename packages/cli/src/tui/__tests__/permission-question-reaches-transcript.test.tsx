/**
 * A question about a call is a stop for the transcript: the counted line of reads above it
 * settles, and a Ctrl+C at the question is not recorded as the person's No.
 */

import {
	BashTool,
	GrepTool,
	LsTool,
	ReadFileTool,
	type SessionEvent,
	ToolManager,
	createToolPresenter,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { testToolset } from '../../test-support/toolset.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

type Step =
	| { readonly ask: { readonly id: string; readonly command: string } }
	| { readonly text: string }
	| {
			readonly toolName: string
			readonly input: unknown
			readonly result: string
			readonly isError?: boolean
			readonly facts?: unknown
	  }

/** What the scripted model does next turn; set by each test before it sends. */
let script: readonly Step[] = []
const decisions: PermissionDecision[] = []

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

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
			toolNames: () => ['computer_use'],
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
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				const registry = new ToolManager({
					toolsets: [testToolset(...[ReadFileTool, GrepTool, BashTool, LsTool])],
					messages: () => [],
				})
				const presenter = createToolPresenter(registry)
				const turnId = generateTurnId()
				let index = 0
				for (const step of script) {
					if ('ask' in step) {
						const decision = await opts?.onPermission?.({
							perCall: true,
							turnId,
							toolCalls: [
								{
									id: step.ask.id,
									name: 'bash',
									input: { command: step.ask.command },
									isDestructive: true,
								},
							],
						} as unknown as PermissionRequest)
						if (decision) decisions.push(decision)
						yield {
							kind: 'tool-end',
							turnId,
							toolUseId: step.ask.id,
							toolName: 'bash',
							isError: false,
							summary: step.ask.command,
							declined: {},
						} as AgentEvent
						continue
					}
					if ('text' in step) {
						yield { kind: 'delta', text: step.text }
						continue
					}
					index += 1
					for (const event of [
						{
							type: 'tool_executing',
							turnId,
							toolUseId: `call-${index}`,
							toolName: step.toolName,
							input: step.input,
						},
						{
							type: 'tool_completed',
							turnId,
							toolUseId: `call-${index}`,
							toolName: step.toolName,
							result: step.result,
							isError: step.isError ?? false,
							...(step.facts !== undefined ? { facts: step.facts } : {}),
						},
					]) {
						const mapped = actual.toAgentEvent(event as unknown as SessionEvent, presenter)
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
	decisions.length = 0
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

async function send(prompt: string): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	screen.press(prompt)
	await screen.waitForRender()
	screen.press('\r')
	return screen
}

const everything = (screen: Screen) => [...screen.scrollback(), ...screen.viewport()].join('\n')

it('settles the line of reads while a question about the next call waits', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{ ask: { id: 'call-ask', command: 'rm -rf build' } },
	]
	const screen = await send('look then remove')
	await waitUntil(screen, () => everything(screen).includes('Do you want'))
	expect(everything(screen)).toContain('Read 1 file')
	expect(everything(screen)).not.toContain('Reading 1 file')
})

it('reads a Ctrl+C at the question as a stop by the person, not as a No', async () => {
	script = [{ ask: { id: 'call-ask', command: 'rm -rf build' } }]
	const screen = await send('remove it')
	await waitUntil(screen, () => everything(screen).includes('Do you want'))
	screen.press('\x03')
	await waitUntil(screen, () => everything(screen).includes('did not run'))
	expect(everything(screen)).toContain('You stopped this, so it did not run.')
	expect(everything(screen)).not.toContain('You declined this')
})

it('still reads a No as declined', async () => {
	script = [{ ask: { id: 'call-ask', command: 'rm -rf build' } }]
	const screen = await send('remove it')
	await waitUntil(screen, () => everything(screen).includes('Do you want'))
	screen.press('n')
	await waitUntil(screen, () => everything(screen).includes('did not run'))
	expect(everything(screen)).toContain('You declined this, so it did not run.')
})
