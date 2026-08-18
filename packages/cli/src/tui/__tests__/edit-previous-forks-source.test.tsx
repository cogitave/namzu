/**
 * Previous-prompt editing is a branch operation, not transcript mutation.
 *
 * This drives the rendered App from `/resume` through Esc ×2, the picker,
 * composer restoration, provider history and durable append. Store helper unit
 * tests cover the real disk transaction; this file proves App actually reaches
 * it and then sends from the prefix it returned.
 */

import {
	type Message,
	type MessageAttachment,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const INITIAL = 'conv-initial'
const SOURCE = 'conv-source'
const FORK = 'conv-edited-fork'

const selectedAttachments: readonly MessageAttachment[] = [
	{ data: 'aGVsbG8=', mediaType: 'image/png' },
	{
		type: 'document',
		data: 'UERG',
		mediaType: 'application/pdf',
		name: 'design.pdf',
		citations: true,
	},
	{
		type: 'stored',
		ref: 'sha256:diagram',
		mediaType: 'image/webp',
		kind: 'image',
		name: 'diagram.webp',
	},
]

let durable = new Map<string, Message[]>()
let sourceBefore: readonly Message[] = []
const sent: Message[][] = []
const forkCalls: Array<{ sourceId: string; userOrdinal: number; expected: Message }> = []

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu-edit-test' }),
	startConversation: async () => INITIAL,
	appendMessages: async (_sessions: unknown, id: string, messages: readonly Message[]) => {
		durable.set(id, [...(durable.get(id) ?? []), ...messages])
	},
	replaceConversation: async (_sessions: unknown, id: string, messages: readonly Message[]) => {
		durable.set(id, [...messages])
	},
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
		createAgentSession: async (): Promise<AgentSession> => ({
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
			approvalLatched: () => false,
			promptExemptTools: () => [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			send: async function* (messages): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				yield { kind: 'delta', text: 'BRANCHED ANSWER' } as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	const messages = [
		createUserMessage('first prompt'),
		createAssistantMessage('first answer'),
		createUserMessage('selected prompt', selectedAttachments),
		createAssistantMessage('answer that must stay only in the source'),
	]
	sourceBefore = messages
	durable = new Map([
		[SOURCE, [...messages]],
		[INITIAL, []],
	])
	sent.length = 0
	forkCalls.length = 0
})

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function frameShows(
	harness: { readonly frames: readonly string[] },
	text: string,
	timeoutMs = 3_000,
): Promise<void> {
	const expected = text.replace(/\s+/g, ' ')
	const started = performance.now()
	while (
		!harness.frames.join('\n').replace(/\s+/g, ' ').includes(expected) &&
		performance.now() - started < timeoutMs
	) {
		await tick(20)
	}
	expect(harness.frames.join('\n').replace(/\s+/g, ' ')).toContain(expected)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!predicate() && performance.now() - started < timeoutMs) await tick(20)
	expect(predicate()).toBe(true)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

async function mountSource() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, '> Type a message… (/help for commands)')
	await submit(harness, '/resume')
	await frameShows(harness, 'Source conversation')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: Source conversation')
	return harness
}

async function openEditor(harness: Awaited<ReturnType<typeof mountSource>>) {
	harness.stdin.write('\x1B')
	await frameShows(harness, 'Press Esc again to edit a previous prompt')
	harness.stdin.write('\x1B')
	await frameShows(harness, 'Edit a previous prompt in a new branch')
}

it('forks before the selection, restores every attachment, and never mutates the source', async () => {
	const harness = await mountSource()
	await openEditor(harness)
	expect(harness.lastFrame()).toContain('selected prompt')

	harness.stdin.write('\r')
	await frameShows(harness, 'Forked into "Source conversation (fork)"')
	await frameShows(harness, 'selected prompt')
	await frameShows(harness, 'Document #2 — design.pdf')
	await frameShows(harness, 'Image #3 — diagram.webp (stored)')

	harness.stdin.write(' revised')
	await tick()
	harness.stdin.write('\r')
	await waitUntil(() => sent.length === 1)
	await frameShows(harness, 'BRANCHED ANSWER')
	await waitUntil(() => (durable.get(FORK)?.length ?? 0) === 4)

	expect(forkCalls).toHaveLength(1)
	expect(forkCalls[0]).toMatchObject({ sourceId: SOURCE, userOrdinal: 1 })
	expect(forkCalls[0]?.expected).toEqual(sourceBefore[2])
	expect(sent[0]?.map((message) => message.content)).toEqual([
		'first prompt',
		'first answer',
		'selected prompt revised',
	])
	const edited = sent[0]?.at(-1)
	expect(edited?.role).toBe('user')
	expect(edited?.role === 'user' ? edited.attachments : undefined).toEqual(selectedAttachments)
	expect(durable.get(FORK)?.map((message) => message.content)).toEqual([
		'first prompt',
		'first answer',
		'selected prompt revised',
		'BRANCHED ANSWER',
	])
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})

it('steps toward older prompts with Esc and permits an empty-prefix branch', async () => {
	const harness = await mountSource()
	await openEditor(harness)

	// The picker opens on the latest prompt. Further Esc presses mean "older",
	// not cancel; q is the explicit reversible exit.
	harness.stdin.write('\x1B')
	await frameShows(harness, '1/2')
	expect(harness.lastFrame()).toContain('first prompt')
	harness.stdin.write('\r')
	await frameShows(harness, 'Forked into "Source conversation (fork)"')
	await frameShows(harness, 'first prompt')

	expect(forkCalls[0]).toMatchObject({ sourceId: SOURCE, userOrdinal: 0 })
	expect(durable.get(FORK)).toEqual([])
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})

it('cancels with q without creating a branch or changing the composer', async () => {
	const harness = await mountSource()
	await openEditor(harness)

	harness.stdin.write('q')
	await frameShows(harness, '> Type a message… (/help for commands)')

	expect(forkCalls).toEqual([])
	expect(durable.get(FORK)).toBeUndefined()
	expect(durable.get(SOURCE)).toEqual(sourceBefore)
})
