import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import {
	type Message,
	createUserMessage,
	isTurnContextEntry,
	turnContextEntries,
	turnContextKey,
} from '../../../types/message/index.js'
import type { PrepareStepContext, PrepareStepResult } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Text a step asks to have recorded becomes an ordinary history entry, after
 * whatever the history ends with. Only text that is new is appended, so each
 * request begins with the whole of the one before it, across the calls of a
 * turn and across turns.
 */

registerMock()

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)
const isRequestOnly = (message: Message): boolean =>
	message.role === 'user' &&
	message.source?.type === 'runtime-context' &&
	message.source.kind === 'step-context'
const cacheable = (messages: readonly Message[]) => {
	const end = messages.findIndex(isRequestOnly)
	return shape(end < 0 ? messages : messages.slice(0, end))
}

function session(name: string) {
	const tools = testToolset({
		name: 'look',
		description: 'Look at something',
		inputSchema: z.object({ what: z.string() }),
		execute: async () => ({ success: true, output: 'seen' }),
	})
	const sessionId = fixtureId.session(name)
	return {
		toolsets: [tools],
		agentId: 'a',
		agentName: 'A',
		systemPrompt: 'You are a coding agent.',
		workingDirectory: process.cwd(),
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		compactionConfig: CompactionConfigSchema.parse({}),
		tenantId: fixtureId.tenant(name),
		projectId: fixtureId.project(name),
		sessionId,
		topicId: fixtureId.topic(name),
		sessionLog: new InMemorySessionLog({ sessionId }),
		retry: false as const,
	}
}

const loop = () =>
	new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
			{ toolCalls: [{ id: 'c2', name: 'look', args: { what: 'y' } }] },
			{ text: 'done' },
		],
	})

const entriesOf = (messages: readonly Message[]) => messages.filter(isTurnContextEntry)

describe('recorded turn context', () => {
	it('follows the operator message, once, however many calls the turn makes', async () => {
		const provider = loop()
		const result = await drainQuery({
			...session('entry-once'),
			provider,
			prepareStep: () => ({ recordedContext: [{ key: 'repository', text: 'REPO STATE' }] }),
			messages: [{ role: 'user', content: 'go' }],
		})
		expect(provider.requests).toHaveLength(3)
		const first = provider.requests[0]?.messages as Message[]
		const asked = first.findIndex((m) => m.role === 'user' && text(m) === 'go')
		const entry = first[asked + 1] as Message
		expect(turnContextKey(entry)).toBe('repository')
		expect(text(entry)).toContain('REPO STATE')
		expect(text(entry)).toContain('not a new user request')
		// The same text on the later calls adds nothing.
		for (const request of provider.requests) {
			expect(entriesOf(request.messages as Message[])).toHaveLength(1)
		}
		expect(entriesOf(result.messages)).toHaveLength(1)
		// And each request begins with the whole of the one before it.
		for (const [i, request] of provider.requests.entries()) {
			if (i === 0) continue
			const before = shape(provider.requests[i - 1]?.messages as Message[])
			expect(shape(request.messages as Message[]).slice(0, before.length)).toEqual(before)
		}
	})

	it('lets a step read what it recorded and say only what is new', async () => {
		const provider = loop()
		const seen: (readonly string[])[] = []
		await drainQuery({
			...session('entry-delta'),
			provider,
			prepareStep: ({ messages, stepNumber }: PrepareStepContext): PrepareStepResult => {
				seen.push(turnContextEntries(messages, 'repository'))
				return { recordedContext: [{ key: 'repository', text: `STATE ${stepNumber}` }] }
			},
			messages: [{ role: 'user', content: 'go' }],
		})
		expect(seen).toEqual([[], ['STATE 1'], ['STATE 1', 'STATE 2']])
		const last = provider.requests.at(-1)?.messages as Message[]
		// Entries are appended after what the history ended with at that call.
		const lines = shape(last)
		const at = (needle: string) => lines.findIndex((l) => l.includes(needle))
		expect(at('STATE 1')).toBeLessThan(at('assistant:'))
		expect(lines.findIndex((l) => l.startsWith('tool:'))).toBeLessThan(at('STATE 2'))
	})

	it('gives the first entry under a key the full header and a later one the short header', async () => {
		const provider = loop()
		const result = await drainQuery({
			...session('entry-header'),
			provider,
			prepareStep: ({ stepNumber }: PrepareStepContext): PrepareStepResult => ({
				recordedContext: [{ key: 'repository', text: `STATE ${stepNumber}` }],
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		const [one, two, three] = entriesOf(result.messages).map(text)
		expect(one).toContain('A later entry with this key adds to or replaces what it says:')
		expect(two).not.toContain('A later entry')
		expect(two).toMatch(
			/^Recorded context \(runtime-generated; not a new user request\) - repository, as of [\d-]+ [\d:]+:\n/,
		)
		expect(three).not.toContain('A later entry')
	})

	it('puts request-only blocks after every recorded entry on every call, so the history before them only grows', async () => {
		const provider = loop()
		await drainQuery({
			...session('entry-tail'),
			provider,
			prepareStep: ({ stepNumber }: PrepareStepContext): PrepareStepResult => ({
				context: `INVENTORY ${stepNumber}`,
				recordedContext: [{ key: 'repository', text: `STATE ${stepNumber}` }],
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		expect(provider.requests).toHaveLength(3)
		let previous: string[] = []
		for (const request of provider.requests) {
			const messages = request.messages as Message[]
			const first = messages.findIndex(isRequestOnly)
			expect(first).toBeGreaterThan(-1)
			// Nothing but request-only blocks (and system text a driver may move) follows the first.
			expect(messages.slice(first).every((m) => isRequestOnly(m) || m.role === 'system')).toBe(true)
			// The history ends with the newest recorded entry (or what the call just appended).
			const history = messages.slice(0, first)
			expect(text(history.at(-1) as Message)).toContain('STATE')
			const cached = cacheable(messages)
			expect(cached.slice(0, previous.length)).toEqual(previous)
			previous = cached
		}
	})

	it('skips empty text and a key that is not a name', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		await drainQuery({
			...session('entry-skip'),
			provider,
			prepareStep: () => ({
				recordedContext: [
					{ key: 'empty', text: '  \n' },
					{ key: 'Bad Key', text: 'x' },
					{ key: 'kept', text: 'KEPT' },
				],
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		const entries = entriesOf(provider.requests[0]?.messages as Message[])
		expect(entries.map(turnContextKey)).toEqual(['kept'])
	})

	it('adds up what several stages record', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		await drainQuery({
			...session('entry-stages'),
			provider,
			prepareStep: [
				() => ({ recordedContext: [{ key: 'one', text: 'ONE' }] }),
				() => ({ recordedContext: [{ key: 'two', text: 'TWO' }] }),
			],
			messages: [{ role: 'user', content: 'go' }],
		})
		const entries = entriesOf(provider.requests[0]?.messages as Message[])
		expect(entries.map(turnContextKey)).toEqual(['one', 'two'])
	})

	it('keeps request-only context out of the history and at the tail', async () => {
		const provider = loop()
		await drainQuery({
			...session('entry-tail'),
			provider,
			prepareStep: () => ({
				context: 'THIS REQUEST ONLY',
				recordedContext: [{ key: 'repository', text: 'REPO STATE' }],
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		const first = shape(provider.requests[0]?.messages as Message[])
		const at = (needle: string) => first.findIndex((l) => l.includes(needle))
		expect(at('REPO STATE')).toBe(at('user:go') + 1)
		expect(at('THIS REQUEST ONLY')).toBeGreaterThan(at('REPO STATE'))
	})

	it('extends the earlier request through the next turn, byte for byte', async () => {
		const base = session('entry-turns')
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
				{ text: 'first answer' },
				{ text: 'second answer' },
			],
		})
		const prepareStep = ({ messages }: PrepareStepContext): PrepareStepResult => {
			const earlier = turnContextEntries(messages, 'repository')
			return earlier.length === 0
				? { recordedContext: [{ key: 'repository', text: 'REPO STATE' }] }
				: {}
		}
		await drainQuery({
			...base,
			provider,
			prepareStep,
			messages: [{ role: 'user', content: 'first question' }],
		})
		const history = (await readFoldedHistory(base.sessionLog)).map((entry) => entry.message)
		await drainQuery({
			...base,
			provider,
			prepareStep,
			turnId: generateTurnId(),
			messages: [...history, createUserMessage('second question')],
		})
		const lastOfFirst = provider.requests[1]?.messages as Message[]
		const firstOfSecond = provider.requests[2]?.messages as Message[]
		const before = cacheable(lastOfFirst)
		// The whole earlier turn is cacheable, operator message and entry included.
		expect(before.some((l) => l.includes('first question'))).toBe(true)
		expect(before.some((l) => l.includes('REPO STATE'))).toBe(true)
		expect(cacheable(firstOfSecond).slice(0, before.length)).toEqual(before)
		// The step saw its entry in the history it was handed, so it recorded once.
		expect(entriesOf(firstOfSecond)).toHaveLength(1)
	})

	it('writes an ordinary message record and never a compaction record', async () => {
		const base = session('entry-log')
		await drainQuery({
			...base,
			provider: loop(),
			prepareStep: ({ stepNumber }) => ({
				recordedContext: [{ key: 'repository', text: `STATE ${stepNumber}` }],
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		const records = (await base.sessionLog.readAll()).entries.map((entry) => entry.record) as {
			type: string
			content?: Message
		}[]
		expect(records.some((r) => r.type === 'compaction')).toBe(false)
		const written = records.filter(
			(r) => r.type === 'message' && r.content && isTurnContextEntry(r.content),
		)
		expect(written).toHaveLength(3)
		const history = await readFoldedHistory(base.sessionLog)
		expect(entriesOf(history.map((h) => h.message)).map((m) => text(m).split('\n')[1])).toEqual([
			'STATE 1',
			'STATE 2',
			'STATE 3',
		])
	})
})
