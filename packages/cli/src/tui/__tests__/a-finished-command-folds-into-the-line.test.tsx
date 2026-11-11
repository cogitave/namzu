/** A shell command that ended well folds into the counted line; one that did not keeps its own row. */

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

const COMMAND_FACTS = { kind: 'command', exitCode: 0 } as const

it('folds finished commands into one line that lists them, oldest first, and keeps no row of their own', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{
			toolName: 'bash',
			input: { command: 'npm test' },
			result: 'tests ok',
			facts: { ...COMMAND_FACTS, stdout: { head: 'tests ok', totalBytes: 8 } },
		},
		{ gate: 'one' },
		{
			toolName: 'bash',
			input: { command: 'tsc --noEmit' },
			result: 'types ok',
			facts: { ...COMMAND_FACTS, stdout: { head: 'types ok', totalBytes: 8 } },
		},
		{ gate: 'two' },
		{ text: 'All green.' },
	]
	const screen = await send('check')
	await waitUntil(screen, () => everything(screen).includes('Reading 1 file, running 1 command…'))
	// Open: the line is in the present tense and the finished command is listed under it.
	expect(everything(screen)).toContain('$ npm test')
	gate('one').open()
	await waitUntil(screen, () => everything(screen).includes('Reading 1 file, running 2 commands…'))
	gate('two').open()
	await waitUntil(screen, () => everything(screen).includes('All green.'))
	const text = screen.scrollback().join('\n')
	expect(text).toContain('Read 1 file, ran 2 commands (ctrl+o to expand)')
	expect(text.indexOf('$ npm test')).toBeGreaterThan(text.indexOf('Read 1 file, ran 2 commands'))
	expect(text.indexOf('$ tsc --noEmit')).toBeGreaterThan(text.indexOf('$ npm test'))
	expect(text).not.toContain('Bash(')
	expect(text).not.toContain('tests ok')
	// Their whole output is on the detailed transcript.
	screen.press('\x0f')
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Showing detailed transcript'),
	)
	const shown = screen.viewport().join('\n')
	expect(shown).toContain('tests ok')
	expect(shown).toContain('types ok')
})

it('draws one command on its own as its own row, with its output', async () => {
	script = [
		{
			toolName: 'bash',
			input: { command: 'npm test' },
			result: 'a\nb\nc',
			facts: { kind: 'command', exitCode: 0, stdout: { head: 'a\nb\nc', totalBytes: 5 } },
		},
		{ text: 'Done.' },
	]
	const screen = await send('check')
	await waitUntil(screen, () => everything(screen).includes('Done.'))
	const text = screen.scrollback().join('\n')
	expect(text).toContain('Bash(npm test)')
	expect(text).toMatch(/⎿ +a\n +b\n +c/)
	expect(text).not.toContain('ran 1 command')
	expect(text).not.toContain('Ran 1 command')
})

it('shows a failed command as its own row, which ends the line, and the next command starts a new one', async () => {
	script = [
		{ toolName: 'bash', input: { command: 'npm test' }, result: 'ok', facts: COMMAND_FACTS },
		{ toolName: 'bash', input: { command: 'tsc' }, result: 'ok', facts: COMMAND_FACTS },
		{
			toolName: 'bash',
			input: { command: 'make' },
			result: 'boom\nError: Command exited with code 3',
			isError: false,
			facts: { kind: 'command', exitCode: 3, stderr: { head: 'boom', totalBytes: 5 } },
		},
		{ toolName: 'bash', input: { command: 'node a' }, result: 'ok', facts: COMMAND_FACTS },
		{ toolName: 'bash', input: { command: 'node b' }, result: 'ok', facts: COMMAND_FACTS },
		{ text: 'One broke.' },
	]
	const screen = await send('check')
	await waitUntil(screen, () => everything(screen).includes('One broke.'))
	const text = screen.scrollback().join('\n')
	const order = [
		'Ran 2 commands',
		'Bash(make)',
		'Exit code 3',
		'Ran 2 commands',
		'One broke.',
	].reduce<number[]>(
		(found, needle) => [...found, text.indexOf(needle, (found.at(-1) ?? -1) + 1)],
		[],
	)
	expect(order.every((at) => at >= 0)).toBe(true)
	expect(text.match(/Ran 2 commands/g)).toHaveLength(2)
	// The failed one is not listed with the others.
	expect(text).not.toContain('$ make')
})

it('does not fold a command that moved to the background, and the line before it settles first', async () => {
	script = [
		{ toolName: 'bash', input: { command: 'npm test' }, result: 'ok', facts: COMMAND_FACTS },
		{ toolName: 'bash', input: { command: 'tsc' }, result: 'ok', facts: COMMAND_FACTS },
		{
			toolName: 'bash',
			input: { command: 'npm run watch', run_in_background: true },
			result: 'Started background job job_1.',
			facts: { kind: 'command', background: true },
		},
		{ text: 'Started.' },
	]
	const screen = await send('check')
	await waitUntil(screen, () => everything(screen).includes('Started.'))
	const text = screen.scrollback().join('\n')
	expect(text.indexOf('Ran 2 commands')).toBeGreaterThanOrEqual(0)
	expect(text.indexOf('Bash(npm run watch')).toBeGreaterThan(text.indexOf('Ran 2 commands'))
	expect(text).toContain('Running in the background')
	expect(text).not.toContain('$ npm run watch')
	expect(text).not.toContain('Ran 3 commands')
})

it('does not count a call to a tool that does not exist, and says so', async () => {
	script = [
		{ toolName: 'read', input: { path: 'one.ts' }, result: 'FIRST evidence' },
		{
			toolName: 'ls',
			input: { path: 'src' },
			result: 'Error: Unknown tool "ls". Available: bash, read',
			isError: true,
			facts: { kind: 'failure', reason: 'unknown_tool', subject: 'ls' },
		},
		{ text: 'Tried.' },
	]
	const screen = await send('look')
	await waitUntil(screen, () => everything(screen).includes('Tried.'))
	const text = screen.scrollback().join('\n')
	expect(text).toContain('Read 1 file')
	expect(text).not.toContain('listed')
	expect(text).not.toContain('listing')
	expect(text).toContain('Ls(src)')
	expect(text).toContain('The model asked for a tool that does not exist (ls)')
})
