/**
 * `/raw` is a render mode over retained source, including rows already printed
 * through Ink's `<Static>`. A prop alone reaches only the live tail. This test
 * drives the real terminal renderer and requires the old scrollback to be
 * cleared and rebuilt in both directions.
 */

import type { Message } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TranscriptMessage, TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const RAW_MARKDOWN = [
	'# Literal heading',
	'',
	'**bold source** and `inline source`',
	'',
	'```ts',
	'const rawFence = true',
	'```',
].join('\n')
let sendCalls = 0
const sentHistories: Message[][] = []
let heldTurn: Promise<void> | null = null
let releaseHeldTurn = () => {}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
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
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			send: async function* (messages: readonly Message[]): AsyncIterable<AgentEvent> {
				sendCalls += 1
				sentHistories.push([...messages])
				yield { kind: 'delta', text: RAW_MARKDOWN } as AgentEvent
				if (heldTurn) {
					// Give the streaming renderer a complete block before parking the
					// iterator. Without this delimiter the renderer deliberately keeps
					// the incomplete Markdown tail private until the terminal event.
					yield { kind: 'delta', text: '\n\n' } as AgentEvent
					await heldTurn
				}
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const { Transcript } = await import('../Transcript.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

beforeEach(() => {
	sendCalls = 0
	sentHistories.length = 0
	heldTurn = null
	releaseHeldTurn = () => {}
})

afterEach(async () => {
	releaseHeldTurn()
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

function holdNextTurn(): void {
	heldTurn = new Promise<void>((resolve) => {
		releaseHeldTurn = resolve
	})
}

async function waitUntil(_screen: Screen, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!predicate() && performance.now() - started < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	expect(predicate()).toBe(true)
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

function scrollback(screen: Screen): string {
	return screen.scrollback().join('\n')
}

it('replays already-settled Markdown as literal source and restores rich rendering', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 100,
		rows: 24,
	})
	mounted = screen
	await waitUntil(screen, () => scrollback(screen).includes('Connected to a-provider'))

	await submit(screen, 'show the source')
	await waitUntil(screen, () => scrollback(screen).includes('const rawFence = true'))
	expect(scrollback(screen)).not.toContain('**bold source**')
	expect(scrollback(screen)).not.toContain('```ts')

	await submit(screen, '/raw on')
	await waitUntil(screen, () => scrollback(screen).includes('**bold source**'))
	const raw = scrollback(screen)
	expect(raw).toContain('# Literal heading')
	expect(raw).toContain('`inline source`')
	expect(raw).toContain('```ts')
	expect(raw).toContain('Raw output mode on')
	expect(screen.writes().filter((write) => write.includes('\x1b[3J'))).toHaveLength(1)

	await submit(screen, '/raw off')
	await waitUntil(screen, () => scrollback(screen).includes('rich transcript rendering restored'))
	expect(scrollback(screen)).not.toContain('**bold source**')
	expect(scrollback(screen)).not.toContain('```ts')
	expect(screen.writes().filter((write) => write.includes('\x1b[3J'))).toHaveLength(2)
	expect(sendCalls).toBe(1)
})

it('clears only the idle display with Ctrl+L and keeps the next model history', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 100,
		rows: 24,
	})
	mounted = screen
	await waitUntil(screen, () => scrollback(screen).includes('Connected to a-provider'))

	await submit(screen, 'first context')
	await waitUntil(screen, () => scrollback(screen).includes('const rawFence = true'))
	const clearsBefore = screen.writes().filter((write) => write.includes('\x1b[3J')).length
	screen.press('\x0c')
	await waitUntil(
		screen,
		() => screen.writes().filter((write) => write.includes('\x1b[3J')).length === clearsBefore + 1,
	)
	await waitUntil(screen, () => !scrollback(screen).includes('const rawFence = true'))

	await submit(screen, 'second context')
	await waitUntil(screen, () => sendCalls === 2)
	expect(sentHistories[1]?.map((message) => message.content)).toEqual([
		'first context',
		RAW_MARKDOWN,
		'second context',
	])
})

it('keeps a running turn visible when Ctrl+L is pressed', async () => {
	holdNextTurn()
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 100,
		rows: 24,
	})
	mounted = screen
	await waitUntil(screen, () => scrollback(screen).includes('Connected to a-provider'))

	await submit(screen, 'held context')
	await waitUntil(screen, () => scrollback(screen).includes('const rawFence = true'))
	const clearsBefore = screen.writes().filter((write) => write.includes('\x1b[3J')).length
	screen.press('\x0c')
	await waitUntil(screen, () => scrollback(screen).includes('Ctrl+L is unavailable'))

	expect(scrollback(screen)).toContain('const rawFence = true')
	expect(screen.writes().filter((write) => write.includes('\x1b[3J'))).toHaveLength(clearsBefore)
	releaseHeldTurn()
})

it('prints complete tool bodies without rich gutters or collapse hints', () => {
	const detail = Array.from({ length: 12 }, (_, i) => `plain-detail-${i + 1}`)
	const messages: TranscriptMessage[] = [
		{
			id: 'tool-1',
			role: 'tool',
			content: 'Bash(ls)',
			glyph: '⏺',
			detail,
			detailRef: 1,
		},
	]
	const harness = render(
		<Transcript messages={messages} pending={null} state="idle" settled={0} resetKey={0} raw />,
	)
	try {
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('plain-detail-12')
		expect(frame).not.toContain('… +6 lines')
		expect(frame).not.toContain('▏')
		expect(frame).not.toContain('⏺')
	} finally {
		harness.unmount()
	}
})
