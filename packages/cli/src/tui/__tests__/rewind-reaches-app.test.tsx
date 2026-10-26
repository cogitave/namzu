/**
 * The rewind dialog, driven through the rendered App: Esc Esc and /rewind open
 * it, each choice does what its label says to the files and the conversation,
 * and a failure stays inside the dialog.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type CompactionResult,
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { FileCheckpointStore } from '../../checkpoints/store.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const INITIAL = 'conv-initial'
const SOURCE = 'conv-source'
const FORK = 'conv-rewound-fork'

let durable = new Map<string, Message[]>()
let sourceBefore: readonly Message[] = []
const sent: Message[][] = []
const forkCalls: Array<{ sourceId: string; userOrdinal: number; expected: Message }> = []
const rangeCalls: Array<{ from?: Message; until?: Message; instructions?: string }> = []
let fileAtFork: string | undefined
let rangeFails = false
let dir: string
let target: string
let store: FileCheckpointStore

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu-edit-test' }),
	startConversation: async () => INITIAL,
	requireWritableConversation: async () => {},
	listRecent: async () => [
		{
			id: SOURCE,
			title: 'Source conversation',
			named: true,
			updatedAt: new Date().toISOString(),
			count: durable.get(SOURCE)?.length ?? 0,
		},
	],
	loadConversation: async (_sessions: unknown, id: string) => [...(durable.get(id) ?? [])],
	forkConversationBeforeUser: async (
		_sessions: unknown,
		sourceId: string,
		userOrdinal: number,
		expected: Message,
	) => {
		forkCalls.push({ sourceId, userOrdinal, expected })
		fileAtFork = await readFile(target, 'utf8')
		const messages = durable.get(sourceId) ?? []
		let seen = -1
		const selectedIndex = messages.findIndex((message) => {
			if (message.role !== 'user') return false
			seen += 1
			return seen === userOrdinal
		})
		const prefix = messages.slice(0, selectedIndex)
		durable.set(FORK, [...prefix])
		return {
			id: FORK,
			title: 'Source conversation (fork)',
			messages: prefix,
			selected: messages[selectedIndex],
		}
	},
	forkConversation: async () => ({ id: FORK, title: 'unused', copied: 0 }),
	setTitle: () => {},
	titleOf: () => undefined,
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (
			_preferences: unknown,
			_detected: unknown,
			options: { readonly scope?: { readonly sessionId: string } },
		): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			checkpoints: store,
			compactRange: async (input: {
				messages: readonly Message[]
				from?: Message
				until?: Message
				instructions?: string
			}): Promise<CompactionResult | null> => {
				rangeCalls.push({
					...(input.from ? { from: input.from } : {}),
					...(input.until ? { until: input.until } : {}),
					...(input.instructions ? { instructions: input.instructions } : {}),
				})
				if (rangeFails) throw new Error('the summary model is unreachable')
				const at = input.messages.indexOf((input.from ?? input.until) as Message)
				const summary = {
					role: 'system' as const,
					content: 'SUMMARY OF EARLIER',
					retain: true,
				} as Message
				const messages = input.from
					? [...input.messages.slice(0, at), summary]
					: [summary, ...input.messages.slice(at)]
				return {
					messages,
					shed: input.messages.length - messages.length,
					summary,
					usage: {} as never,
				}
			},
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => [],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			promptExemptTools: () => [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (messages): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				yield { kind: 'delta', text: 'BRANCHED ANSWER' } as AgentEvent
				// The kernel records the turn in the conversation the session's
				// scope names when the turn begins: its user message, then the answer.
				const sessionId = options.scope?.sessionId
				const user = messages.at(-1)
				if (sessionId && user) {
					durable.set(sessionId, [
						...(durable.get(sessionId) ?? []),
						user,
						createAssistantMessage('BRANCHED ANSWER'),
					])
				}
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const tick = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'namzu-rewind-app-'))
	target = join(dir, 'a.txt')
	await writeFile(target, 'one\n')
	store = new FileCheckpointStore(join(dir, '.ck', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede'), dir)
	// The reply to "selected prompt" (the second user message) edited a.txt.
	store.beginTurn('selected prompt', undefined, { promptOrdinal: 1 })
	await store.snapshot(target)
	await writeFile(target, 'two\nthree\n')
	await store.settle(target, { ok: true, first: true })
	const messages = [
		createUserMessage('first prompt'),
		createAssistantMessage('first answer'),
		createUserMessage('selected prompt'),
		createAssistantMessage('answer that must stay only in the source'),
	]
	sourceBefore = messages
	durable = new Map([
		[SOURCE, [...messages]],
		[INITIAL, []],
	])
	sent.length = 0
	forkCalls.length = 0
	rangeCalls.length = 0
	fileAtFork = undefined
	rangeFails = false
})

afterEach(async () => {
	for (const harness of mounted) harness.unmount()
	await rm(dir, { recursive: true, force: true })
	mounted.length = 0
	vi.restoreAllMocks()
})

/** Look again after each turn of the event loop; setImmediate is not faked. */
async function framesShowOnFakeClock(
	harness: { readonly frames: readonly string[] },
	text: string,
): Promise<void> {
	const expected = text.replace(/\s+/g, ' ')
	for (let turn = 0; turn < 2_000; turn++) {
		if (harness.frames.some((f) => f.replace(/\s+/g, ' ').includes(expected))) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(harness.frames.at(-1), `never showed: ${text}`).toContain(text)
}

async function frameShows(
	harness: { readonly frames: readonly string[] },
	text: string,
	timeoutMs?: number,
): Promise<void> {
	const expected = text.replace(/\s+/g, ' ')
	await vi.waitFor(
		() => expect(harness.frames.join('\n').replace(/\s+/g, ' ')).toContain(expected),
		timeoutMs,
	)
}

async function waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void> {
	await vi.waitFor(() => expect(predicate()).toBe(true), timeoutMs)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

async function mountSource() {
	const harness = render(<App ctx={{ cwd: dir, version: '0.0.0-test' } satisfies TuiContext} />)
	mounted.push(harness)
	await frameShows(harness, '❯ Type a message… (/help for commands)')
	await submit(harness, '/resume')
	await frameShows(harness, 'Source conversation')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: Source conversation')
	return harness
}

async function openRewind(harness: Awaited<ReturnType<typeof mountSource>>) {
	// The second Esc counts only inside an 800 ms window, so the two presses are
	// spaced on a fake clock: 50 ms apart whatever the host is doing. The terminal
	// parser holds a lone Esc back on a timer, which the same clock moves.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		harness.stdin.write('\x1B')
		await vi.advanceTimersByTimeAsync(50)
		expect(harness.lastFrame()).not.toContain('Press Esc again')
		harness.stdin.write('\x1B')
		await vi.advanceTimersByTimeAsync(50)
		await framesShowOnFakeClock(harness, 'Restore the code and/or conversation to the point before')
	} finally {
		vi.useRealTimers()
	}
}

const UP = '\x1B[A'
const DOWN = '\x1B[B'

/** Move to the prompt `ups` rows above the present and open its options. */
async function openOptions(harness: Awaited<ReturnType<typeof mountSource>>, ups: number) {
	for (let i = 0; i < ups; i++) harness.stdin.write(UP)
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Confirm you want to restore to the point before you sent this message')
}

it('lists the prompts with what each would do to the files, and the present last', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	const frame = harness.lastFrame() ?? ''
	expect(frame).toContain('Rewind')
	expect(frame).toContain('first prompt')
	expect(frame).toContain('selected prompt')
	await frameShows(harness, 'a.txt +2 -1')
	expect(frame).toContain('(current)')
	expect(frame.indexOf('(current)')).toBeGreaterThan(frame.indexOf('selected prompt'))
})

it('opens the same dialog from /rewind, /undo and /checkpoint', async () => {
	for (const command of ['/rewind', '/undo', '/checkpoint']) {
		const harness = await mountSource()
		await submit(harness, command)
		await frameShows(harness, 'Restore the code and/or conversation to the point before')
		harness.stdin.write('\x1B')
		await frameShows(harness, '❯ Type a message… (/help for commands)')
		harness.unmount()
	}
})

it('shows the options for a prompt, the line that follows the focus, and the warning', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	await frameShows(harness, 'Restore code and conversation')
	await frameShows(harness, 'The conversation will be forked.')
	await frameShows(harness, 'The code will be restored +2 -1 in a.txt.')
	await frameShows(harness, 'Rewinding does not affect files edited manually or via bash.')
	const frame = harness.lastFrame() ?? ''
	for (const label of [
		'Restore conversation',
		'Restore code',
		'Summarize from here',
		'Summarize up to here',
		'Never mind',
	]) {
		expect(frame).toContain(label)
	}
	harness.stdin.write(DOWN)
	harness.stdin.write(DOWN)
	await frameShows(harness, 'The conversation will be unchanged.')
	// Esc steps back to the list.
	harness.stdin.write('\x1B')
	await frameShows(harness, 'Restore the code and/or conversation to the point before')
})

it('Restore code puts the files back and leaves the conversation alone', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	harness.stdin.write(DOWN)
	harness.stdin.write(DOWN)
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Restored the tree to before turn 1')
	expect(await readFile(target, 'utf8')).toBe('one\n')
	expect(forkCalls).toEqual([])
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})

it('Restore code and conversation restores the files first, then forks', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	harness.stdin.write('\r')
	await frameShows(harness, 'Forked into "Source conversation (fork)"')
	await frameShows(harness, 'Restored the tree to before turn 1')
	expect(fileAtFork).toBe('one\n')
	expect(forkCalls).toHaveLength(1)
	expect(forkCalls[0]).toMatchObject({ sourceId: SOURCE, userOrdinal: 1 })
	// The prompt is back in the composer for editing.
	await frameShows(harness, 'selected prompt')
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})

it('Restore conversation forks and leaves the files alone', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	harness.stdin.write(DOWN)
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Forked into "Source conversation (fork)"')
	expect(await readFile(target, 'utf8')).toBe('two\nthree\n')
})

it('Summarize up to here asks for the part before the prompt and stays at the end', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	for (let i = 0; i < 4; i++) harness.stdin.write(DOWN)
	await frameShows(harness, 'Preceding messages will be summarized.')
	for (const ch of 'keep the plan') harness.stdin.write(ch)
	await frameShows(harness, 'Summarize up to here: keep the plan')
	harness.stdin.write('\r')
	await frameShows(harness, 'Conversation summarized.')
	expect(rangeCalls).toHaveLength(1)
	expect(rangeCalls[0]?.until).toBe(sourceBefore[2])
	expect(rangeCalls[0]?.from).toBeUndefined()
	expect(rangeCalls[0]?.instructions).toBe('keep the plan')
	expect(forkCalls).toEqual([])
})

it('Summarize from here asks for the prompt and what follows, and returns the prompt to the composer', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	for (let i = 0; i < 3; i++) harness.stdin.write(DOWN)
	await frameShows(harness, 'Messages after this point will be summarized.')
	await frameShows(harness, 'add context (optional)')
	harness.stdin.write('\r')
	await frameShows(harness, 'Conversation summarized.')
	expect(rangeCalls[0]?.from).toBe(sourceBefore[2])
	expect(rangeCalls[0]?.until).toBeUndefined()
	await frameShows(harness, '❯ selected prompt')
})

it('keeps a failure inside the dialog, in the words it gave, and stays open', async () => {
	rangeFails = true
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	for (let i = 0; i < 3; i++) harness.stdin.write(DOWN)
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Failed to summarize:')
	await frameShows(harness, 'Confirm you want to restore to the point before you sent this message')
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})

it('Never mind goes back to the list; the present closes the dialog', async () => {
	const harness = await mountSource()
	await openRewind(harness)
	await openOptions(harness, 1)
	harness.stdin.write('\x1B[F')
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Restore the code and/or conversation to the point before')
	harness.stdin.write('\x1B[F')
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, '❯ Type a message… (/help for commands)')
	expect(forkCalls).toEqual([])
	expect(await readFile(target, 'utf8')).toBe('two\nthree\n')
})
