import { type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/core'
import type { QueryParams, SessionEvent, SessionId, SessionIndex, TurnId } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How an AG-UI thread and run map onto a namzu session and turn.
 *
 * A thread is a session and a run is one turn of it. The client's `threadId`
 * and `runId` are echoed verbatim and are never namzu ids: the kernel mints
 * the turn id, and the adapter records the client's ids on the turn's
 * `origin`, which is how the index maps the next run on the thread back to
 * its session.
 *
 * The SDK's `query()` is replaced here so the adapter's side of the contract
 * is tested on its own: what it hands the kernel, what it resolves, and how it
 * reports the kernel refusing a second turn.
 */

const sdk = vi.hoisted(() => ({
	query: vi.fn(),
	minted: [] as string[],
}))

vi.mock('@namzu/sdk', () => ({
	query: sdk.query,
	generateSessionId: () => {
		const id = `0199b3a0-0000-7000-8000-${String(sdk.minted.length + 1).padStart(12, '0')}`
		sdk.minted.push(id)
		return id
	},
	isEntityId: (value: unknown) =>
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
	isTurnInProgressError: (value: unknown) =>
		value instanceof Error && value.name === 'TurnInProgressError',
	toolResultToText: (content: unknown) => String(content),
}))

const { AGUIAdapter } = await import('../adapter.js')
type Context = import('../adapter.js').AGUITurnContext

const SESSION = '0199b3a0-0000-7000-8000-0000000000f1' as SessionId
const TURN = '0199b3a0-0000-7000-8000-0000000000f2' as TurnId

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
	return {
		threadId: 'thread: the client’s own / 1',
		runId: 'client-run-7',
		messages: [{ id: 'u1', role: 'user', content: 'Hello' }],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
		...overrides,
	}
}

function params(sessionId: SessionId = SESSION): QueryParams {
	return { sessionId, messages: [] } as unknown as QueryParams
}

/** A kernel turn that answers `text`. */
function answering(text: string) {
	return async function* (received: QueryParams): AsyncGenerator<SessionEvent, unknown> {
		const base = { sessionId: received.sessionId, turnId: TURN }
		yield {
			...base,
			type: 'turn_started',
			userMessageId: 'm0',
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
		} as SessionEvent
		yield {
			...base,
			type: 'message_completed',
			iteration: 1,
			messageId: 'm1',
			stopReason: 'end_turn',
			content: text,
		} as SessionEvent
		yield { ...base, type: 'turn_completed', result: text } as SessionEvent
		return {}
	}
}

async function collect(stream: AsyncIterable<BaseEvent>): Promise<BaseEvent[]> {
	const events: BaseEvent[] = []
	for await (const event of stream) events.push(event)
	return events
}

/** An index whose refs are what the adapter's recorded origins claimed. */
function fakeIndex(sessions: SessionId[] = []) {
	const refs = new Map<string, SessionId>()
	const index: Pick<SessionIndex, 'getSession' | 'resolveExternal'> = {
		getSession: async (id) => (sessions.includes(id) ? ({ id } as never) : undefined),
		resolveExternal: async (protocol, kind, externalId) => {
			const sessionId = refs.get(`${protocol}\0${kind}\0${externalId}`)
			return sessionId ? { protocol, kind, externalId, sessionId } : undefined
		},
	}
	/** What deriving the index from the turn's records does with its origin. */
	const record = (received: QueryParams & { origin?: { externalSessionId?: string } }) => {
		const thread = received.origin?.externalSessionId
		if (thread !== undefined) refs.set(`ag-ui\0thread\0${thread}`, received.sessionId)
	}
	return { index, record }
}

beforeEach(() => {
	sdk.query.mockReset()
	sdk.minted.length = 0
})

describe('an AG-UI run is one namzu turn', () => {
	it('echoes the client ids verbatim and records them as the turn’s origin', async () => {
		let received: (QueryParams & { origin?: unknown }) | undefined
		sdk.query.mockImplementation((p: QueryParams) => {
			received = p
			return answering('hi')(p)
		})
		const adapter = new AGUIAdapter({ createQuery: () => params() })

		const events = await collect(adapter.run(input()))

		expect(events[0]).toEqual({
			type: EventType.RUN_STARTED,
			threadId: 'thread: the client’s own / 1',
			runId: 'client-run-7',
		})
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			threadId: 'thread: the client’s own / 1',
			runId: 'client-run-7',
			result: 'hi',
		})
		expect(received?.origin).toEqual({
			protocol: 'ag-ui',
			kind: 'prompt',
			externalSessionId: 'thread: the client’s own / 1',
			externalTurnId: 'client-run-7',
		})
		// The client's run id is never a namzu id: the kernel mints the turn.
		expect(received).not.toHaveProperty('turnId')
		expect(received).not.toHaveProperty('runId')
	})

	it('creates a session for an unknown thread, and the next run on it reuses that session', async () => {
		const { index, record } = fakeIndex()
		const seen: (Context['session'] | undefined)[] = []
		sdk.query.mockImplementation((p: QueryParams) => {
			record(p)
			return answering('ok')(p)
		})
		const adapter = new AGUIAdapter({
			sessions: index,
			createQuery: ({ session }) => {
				seen.push(session)
				return params(session?.sessionId)
			},
		})

		await collect(adapter.run(input({ runId: 'first' })))
		await collect(adapter.run(input({ runId: 'second' })))

		expect(seen[0]).toEqual({ sessionId: sdk.minted[0], created: true })
		expect(seen[1]).toEqual({ sessionId: sdk.minted[0], created: false })
		expect(sdk.minted).toHaveLength(1)
	})

	it('uses a thread id that is an existing session as that session', async () => {
		const { index } = fakeIndex([SESSION])
		let seen: Context['session']
		sdk.query.mockImplementation(answering('ok'))
		const adapter = new AGUIAdapter({
			sessions: index,
			createQuery: ({ session }) => {
				seen = session
				return params(session?.sessionId)
			},
		})

		await collect(adapter.run(input({ threadId: SESSION })))

		expect(seen).toEqual({ sessionId: SESSION, created: false })
	})

	it('leaves the session to the host when it gave the adapter no index', async () => {
		let seen: Context | undefined
		sdk.query.mockImplementation(answering('ok'))
		const adapter = new AGUIAdapter({
			createQuery: (context) => {
				seen = context
				return params()
			},
		})

		await collect(adapter.run(input()))

		expect(seen).not.toHaveProperty('session')
	})

	it('answers a second run on a busy thread with RUN_ERROR NAMZU_TURN_IN_PROGRESS', async () => {
		const onError = vi.fn()
		// The kernel refuses when the turn begins, on the first pull, and the
		// generator is finished after that, as a real one would be.
		sdk.query.mockImplementation(() => ({
			refused: false,
			async next() {
				if (this.refused) return { done: true, value: undefined }
				this.refused = true
				const refused = new Error(`Session ${SESSION} already has an active turn.`)
				refused.name = 'TurnInProgressError'
				throw refused
			},
			return: async () => ({ done: true, value: undefined }),
			[Symbol.asyncIterator]() {
				return this
			},
		}))
		const adapter = new AGUIAdapter({ createQuery: () => params(), onError })

		const events = await collect(adapter.run(input()))

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: 'NAMZU_TURN_IN_PROGRESS',
		})
		expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false)
		// The client's conflict, not a host failure.
		expect(onError).not.toHaveBeenCalled()
	})

	it('ignores a child session’s events on the parent’s stream', async () => {
		sdk.query.mockImplementation(async function* (p: QueryParams) {
			yield {
				type: 'turn_started',
				sessionId: p.sessionId,
				turnId: TURN,
				userMessageId: 'm0',
				config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
			} as SessionEvent
			yield {
				type: 'turn_completed',
				sessionId: '0199b3a0-0000-7000-8000-0000000000f9',
				turnId: '0199b3a0-0000-7000-8000-0000000000fa',
				result: 'child answer',
				lineage: { parentSessionId: p.sessionId, rootSessionId: p.sessionId, depth: 1 },
			} as SessionEvent
			yield {
				type: 'turn_completed',
				sessionId: p.sessionId,
				turnId: TURN,
				result: 'root answer',
			} as SessionEvent
			return {}
		})
		const adapter = new AGUIAdapter({ createQuery: () => params() })

		const events = await collect(adapter.run(input()))

		expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toEqual([
			expect.objectContaining({ result: 'root answer' }),
		])
		expect(JSON.stringify(events)).not.toContain('child answer')
	})
})
