/**
 * Through the App: reasoning that came before a counted line of reads is drawn
 * above that line in the detailed transcript, and the reasoning before the
 * answer above the answer. The wiring is the App's own: which reasoning a row
 * takes when it is written.
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
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

type Step =
	| { readonly gate: string }
	| { readonly text: string }
	| { readonly think: string }
	| {
			readonly toolName: string
			readonly input: unknown
			readonly result: string
			readonly isError?: boolean
			readonly facts?: unknown
	  }

/** What the scripted model does next turn; set by each test before it sends. */
let script: readonly Step[] = []
const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
function gate(name: string) {
	let entry = gates.get(name)
	if (!entry) {
		let open = () => {}
		const promise = new Promise<void>((resolve) => {
			open = resolve
		})
		entry = { promise, open }
		gates.set(name, entry)
	}
	return entry
}

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
			send: async function* (): AsyncIterable<AgentEvent> {
				const registry = new ToolManager({
					toolsets: [testToolset(...[ReadFileTool, GrepTool, BashTool, LsTool])],
					messages: () => [],
				})
				const presenter = createToolPresenter(registry)
				const turnId = generateTurnId()
				let index = 0
				for (const step of script) {
					if ('gate' in step) {
						await gate(step.gate).promise
						continue
					}
					if ('think' in step) {
						yield { kind: 'reasoning', text: step.think }
						yield { kind: 'reasoning', text: '', done: true }
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

const everything = (screen: Screen) => [...screen.scrollback(), ...screen.viewport()].join('\n')

it('draws each thought above the counted line or the answer it led to', async () => {
	script = [
		{ think: 'first-thought' },
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'one' },
		{ think: 'second-thought' },
		{ toolName: 'read', input: { path: 'two.ts' }, result: 'two' },
		{ think: 'final-thought' },
		{ text: 'the-answer' },
	]
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	screen.press('look')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => everything(screen).includes('the-answer'))
	screen.press('\x0f')
	await waitUntil(screen, () => everything(screen).includes('Showing detailed transcript'))
	const text = screen.viewport().join('\n')
	const at = (needle: string) => {
		const i = text.indexOf(needle)
		expect(i, `${needle} should be on the screen`).toBeGreaterThanOrEqual(0)
		return i
	}
	const group = at('Read 2 files')
	expect(at('first-thought')).toBeGreaterThan(-1)
	expect(at('first-thought')).toBeLessThan(group)
	expect(at('second-thought')).toBeLessThan(group)
	expect(at('final-thought')).toBeGreaterThan(group)
	expect(at('final-thought')).toBeLessThan(at('the-answer'))
})
