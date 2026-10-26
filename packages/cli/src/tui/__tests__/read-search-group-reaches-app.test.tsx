/** Consecutive reads and searches reach the screen as one counted line, live and settled. */

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
	for (const entry of gates.values()) entry.open()
	gates.clear()
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

it('counts a run of looks live, settles it on the reply text, and starts a new line after it', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{ gate: 'one' },
		{ toolName: 'grep', input: { pattern: 'needle', path: 'src' }, result: 'SEARCH evidence' },
		{ toolName: 'bash', input: { command: 'cat two.ts | head' }, result: 'SECOND evidence' },
		{ toolName: 'ls', input: { path: 'src' }, result: 'a.ts\nb.ts' },
		{ gate: 'two' },
		{ text: 'That explains it.' },
		{ toolName: 'read', input: { path: 'three.ts' }, result: 'THIRD evidence' },
		{ toolName: 'bash', input: { command: 'npm test' }, result: 'ok' },
	]
	const screen = await send('look around')
	await waitUntil(screen, () => everything(screen).includes('Reading 1 file…'))
	// The call that is still open shows its target under the line, and no row of its own.
	expect(everything(screen)).toContain('one.ts')
	expect(everything(screen)).not.toContain('Explored')
	gate('one').open()
	await waitUntil(screen, () =>
		everything(screen).includes('Searching for 1 pattern, reading 2 files, listing 1 directory…'),
	)
	gate('two').open()
	await waitUntil(screen, () => everything(screen).includes('Bash(npm test)'))
	const text = screen.scrollback().join('\n')
	expect(text.match(/Searched for 1 pattern, read 2 files, listed 1 directory/g)).toHaveLength(1)
	expect(text.match(/Read 1 file/g)).toHaveLength(1)
	expect(text).not.toContain('Explored')
	expect(text).not.toContain('FIRST evidence')
	const order = [
		'Searched for 1 pattern, read 2 files, listed 1 directory',
		'That explains it.',
		'Read 1 file',
		'Bash(npm test)',
	].map((line) => text.indexOf(line))
	expect(order.every((at) => at >= 0)).toBe(true)
	expect([...order].sort((a, b) => a - b)).toEqual(order)
	// Nothing live is left over once the turn is done.
	expect(text).not.toMatch(/(Searching|Reading|Listing) /)
})

it('keeps a failed look in the line, with its error behind the detailed transcript', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{ toolName: 'read', input: { path: 'missing.ts' }, result: 'no such file', isError: true },
		{ text: 'Done.' },
	]
	const screen = await send('look')
	await waitUntil(screen, () => everything(screen).includes('Done.'))
	const text = screen.scrollback().join('\n')
	// Both calls are counted and the failure is not a row of its own.
	expect(text).toContain('Read 2 files (ctrl+o to expand)')
	expect(text).not.toContain('no such file')
	expect(text).not.toContain('missing.ts')
	screen.press('\x0f')
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Showing detailed transcript'),
	)
	const shown = screen.viewport().join('\n')
	expect(shown).toContain('FIRST evidence')
	expect(shown).toContain('Error: no such file')
	expect(shown).not.toContain('(ctrl+o to expand)')
})

it('counts a shell search that found nothing as a search, and the detailed transcript says so', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{
			toolName: 'bash',
			input: { command: 'grep -rn needle src' },
			result: '(no output)',
			facts: { kind: 'command', exitCode: 1, exitNote: 'No matches found' },
		},
		{ text: 'Done.' },
	]
	const screen = await send('look')
	await waitUntil(screen, () => everything(screen).includes('Done.'))
	const text = screen.scrollback().join('\n')
	expect(text).toContain('Searched for 1 pattern, read 1 file (ctrl+o to expand)')
	expect(text).not.toContain('Exit code')
	expect(text).not.toContain('Error:')
	screen.press('\x0f')
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Showing detailed transcript'),
	)
	const shown = screen.viewport().join('\n')
	expect(shown).toContain('No matches found')
	expect(shown).not.toContain('Error:')
})

it('still shows a real shell failure as an error in the detailed transcript', async () => {
	script = [
		{
			toolName: 'bash',
			input: { command: 'grep -rn needle /nope' },
			result: 'grep: /nope: No such file or directory',
			isError: true,
			facts: { kind: 'command', exitCode: 2 },
		},
		{ text: 'Done.' },
	]
	const screen = await send('look')
	await waitUntil(screen, () => everything(screen).includes('Done.'))
	screen.press('\x0f')
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Showing detailed transcript'),
	)
	const shown = screen.viewport().join('\n')
	expect(shown).toContain('No such file or directory')
	expect(shown).toMatch(/Error|Exit code 2/)
})
