/** Stateless stdin history reaches the real command boundary intact or not at all. */

import { PassThrough, Readable } from 'node:stream'
import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

const { sent, constructed, probeAgentSession } = vi.hoisted(() => ({
	sent: [] as Message[][],
	constructed: [] as unknown[],
	probeAgentSession: vi.fn(async () => ({
		preferences: {
			version: 3 as const,
			providers: [{ id: 'deepseek' as const }],
			subagents: { active: [] as string[] },
		},
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	})),
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession,
	createAgentSession: vi.fn(async (...args: unknown[]) => {
		constructed.push(args)
		return fakeAgentSession({
			providerSummary: 'stub',
			modelSummary: 'stub',
			send: async function* (messages: readonly Message[]) {
				sent.push([...messages])
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		})
	}),
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({
		root: '/state',
		backend: 'central',
		topicId: 'top_stateless',
		projectId: 'prj_stateless',
		tenantId: 'tnt_stateless',
	})),
	resolveConversation: vi.fn(),
	loadConversation: vi.fn(),
	appendMessages: vi.fn(),
	replaceConversation: vi.fn(),
}))

const { runStreamCommand } = await import('../run-stream.js')
const ctx = { config: {} } as unknown as CommandContext

let realStdin: PropertyDescriptor | undefined

/**
 * A real readable in place of stdin, not a patched iterator: the reader
 * waits for the first byte or end-of-input before it iterates, so a mock
 * that only answers the iterator never reaches it.
 */
function stdin(raw: string | Readable): void {
	realStdin ??= Object.getOwnPropertyDescriptor(process, 'stdin')
	const fake = typeof raw === 'string' ? Readable.from([Buffer.from(raw)]) : raw
	Object.defineProperty(process, 'stdin', {
		configurable: true,
		get: () => Object.assign(fake, { isTTY: false }),
	})
}

async function run(raw: string | Readable): Promise<{ code: number; events: unknown[] }> {
	stdin(raw)
	const lines: string[] = []
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	const code = await runStreamCommand.handler({ rawArgs: ['next question'], ctx } as never)
	return {
		code,
		events: lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown),
	}
}

beforeEach(() => {
	sent.length = 0
	constructed.length = 0
	probeAgentSession.mockClear()
})

afterEach(() => {
	vi.restoreAllMocks()
	if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
})

describe('run-stream stateless history admission', () => {
	it('hands the exact opaque tool history to AgentSession.send', async () => {
		const prior = [
			{
				role: 'system',
				content:
					'[WORKING MEMORY] Authoritative state for this conversation — you produced these.\n\n- artifact: notes.txt',
			},
			{ role: 'user', content: 'inspect', attachments: [] },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'call_exact',
						type: 'function',
						function: { name: 'read', arguments: '{"path":"notes.txt"}' },
					},
				],
				reasoning: [
					{
						type: 'thinking',
						text: 'opaque',
						signature: 'SIGNATURE_EXACT',
						encrypted: 'ENCRYPTED_EXACT',
					},
				],
				futureOpaque: 'FUTURE_EXACT',
			},
			{
				role: 'tool',
				content: [{ type: 'text', text: 'RESULT_EXACT' }],
				toolCallId: 'call_exact',
				isError: false,
			},
			{
				role: 'assistant',
				content: 'prior answer',
				citations: [
					{
						citedText: 'citation exact',
						documentIndex: 0,
						location: { kind: 'char', start: 1, end: 8 },
					},
				],
			},
		]

		const result = await run(JSON.stringify(prior))

		expect(result.code).toBe(0)
		expect(constructed).toHaveLength(1)
		expect((constructed[0] as unknown[])[2]).toMatchObject({
			stateRoot: '/state',
			scope: {
				topicId: 'top_stateless',
				projectId: 'prj_stateless',
				tenantId: 'tnt_stateless',
			},
		})
		expect(sent).toHaveLength(1)
		expect(sent[0]?.slice(0, -1)).toEqual(prior)
		expect(sent[0]?.at(-1)).toMatchObject({ role: 'user', content: 'next question' })
	})

	it.each([
		{
			name: 'malformed JSON',
			raw: '[{"role":"user","content":"secret"}',
			needle: 'stdin history is not valid JSON',
		},
		{
			name: 'shape-valid result-before-call history',
			raw: JSON.stringify([
				{ role: 'user', content: 'start' },
				{ role: 'tool', content: 'too early', toolCallId: 'call_x' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{
							id: 'call_x',
							type: 'function',
							function: { name: 'read', arguments: '{}' },
						},
					],
				},
			]),
			needle: 'messages[1] is a tool result with no pending call',
		},
	])('refuses $name before provider probing or session construction', async ({ raw, needle }) => {
		const result = await run(raw)

		expect(result.code).toBe(0)
		expect(result.events).toEqual([
			{ kind: 'error', message: `invalid stdin history: ${needle}` },
			{ kind: 'done' },
		])
		expect(probeAgentSession).not.toHaveBeenCalled()
		expect(constructed).toEqual([])
		expect(sent).toEqual([])
	})
})

describe('run-stream and a pipe that never closes', () => {
	it('starts the run after the first-byte deadline instead of waiting for end-of-input', async () => {
		const silent = new PassThrough()
		try {
			const { code, events } = await run(silent)
			expect(code).toBe(0)
			expect(events.some((e) => (e as { kind: string }).kind === 'error')).toBe(false)
			expect(sent.at(-1)?.map((m) => m.role)).toEqual(['user'])
		} finally {
			silent.destroy()
		}
	})
})
