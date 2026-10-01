import type {
	CheckpointId,
	HITLResumeDecision,
	SessionEvent,
	SessionId,
	ToolUseId,
	Turn,
	TurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveTurn, type QuestionRequest } from '../turn.js'

const SESSION = '0199b3a0-0000-7000-8000-0000000000e1' as SessionId
const TURN = '3f747aa4-e0fc-4278-ae40-f895280bb9fe' as TurnId
const CHILD = 'b272c51e-296e-4d1f-ac1c-43b5e4b5e572' as TurnId
const TOOL = 'call_ask' as ToolUseId
const CHECKPOINT = '0199b3a0-0000-7000-8000-0000000000e2' as CheckpointId
const REQUEST: QuestionRequest = {
	type: 'user_question',
	sessionId: SESSION,
	turnId: TURN,
	checkpointId: CHECKPOINT,
	question: {
		questionId: `${TOOL}:confirm`,
		question: 'Continue?',
		options: [],
		multiSelect: false,
		allowFreeText: true,
	},
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

/** The final turn value is unused: these fixtures test the one-event buffer. */
async function* source(
	event: SessionEvent,
	gate?: Promise<void>,
): AsyncGenerator<SessionEvent, Turn> {
	await gate
	yield event
	return {} as Turn
}

function waitingTurn(): { turn: LiveTurn; answer: Promise<HITLResumeDecision> } {
	const turn = new LiveTurn()
	turn.turnId = TURN
	const answer = turn.park(REQUEST, 'question')
	turn.unannounced()[0]!.announced = true
	return { turn, answer }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('a native tool event around an announced client wait', () => {
	const notifications: SessionEvent[] = [
		{
			type: 'tool_executing',
			sessionId: SESSION,
			turnId: TURN,
			toolUseId: TOOL,
			toolName: 'ask',
			input: {},
		},
		{
			type: 'tool_progress',
			sessionId: SESSION,
			turnId: TURN,
			toolUseId: TOOL,
			toolName: 'ask',
			message: 'Waiting for the client.',
		},
		{
			type: 'user_question_asked',
			sessionId: SESSION,
			turnId: TURN,
			checkpointId: CHECKPOINT,
			questionId: REQUEST.question.questionId,
			question: REQUEST.question.question,
		},
		{
			type: 'tool_completed',
			sessionId: SESSION,
			turnId: TURN,
			toolUseId: 'call_parallel' as ToolUseId,
			toolName: 'parallel_read',
			result: 'Read complete.',
			isError: false,
		},
	]

	it.each(notifications)('preserves a buffered $type when detaching', async (event) => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		// Consume park's wakeup before asking for a source event.
		await turn.wait(turn.signal)
		turn.start(source(event))
		await turn.wait(turn.signal)
		const expire = vi.fn()
		turn.detach(1_000, expire)
		expect(turn.progressed).toBe(false)
		expect(expire).not.toHaveBeenCalled()
		// No detached reads or event loss: the next run still receives it.
		expect(turn.take()).toEqual({ next: { value: event, done: false } })
		turn.close()
		await expect(answer).resolves.toMatchObject({ action: 'abort' })
		await turn.drain()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not overwrite the buffered event when the resuming run pulls before taking it', async () => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		await turn.wait(turn.signal)
		const first = notifications[0]!
		const second = notifications[1]!
		const native = (async function* (): AsyncGenerator<SessionEvent, Turn> {
			yield first
			yield second
			return {} as Turn
		})()
		const next = vi.spyOn(native, 'next')
		turn.start(native)
		await turn.wait(turn.signal)
		const expire = vi.fn()
		turn.detach(1_000, expire)
		turn.attach(undefined)
		turn.answer(REQUEST.question.questionId, { action: 'continue' })
		await answer
		// drive() does this before checking the outcome on a resumed run.
		turn.pull()
		expect(next).toHaveBeenCalledTimes(1)
		expect(turn.take()).toEqual({ next: { value: first, done: false } })
		turn.pull()
		await turn.wait(turn.signal)
		expect(next).toHaveBeenCalledTimes(2)
		expect(turn.take()).toEqual({ next: { value: second, done: false } })
		expect(expire).not.toHaveBeenCalled()
		turn.close()
		await turn.drain()
	})

	it('keeps a startup event arriving after detach, then accepts the answer', async () => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		await turn.wait(turn.signal)
		const gate = deferred()
		const event = notifications[0]!
		turn.start(source(event, gate.promise))
		const expire = vi.fn()
		turn.detach(1_000, expire)
		gate.resolve()
		await turn.wait(turn.signal)
		expect(expire).not.toHaveBeenCalled()
		turn.attach(undefined)
		expect(turn.answer(REQUEST.question.questionId, { action: 'continue' })).toBe(true)
		await expect(answer).resolves.toEqual({ action: 'continue' })
		expect(turn.take()).toEqual({ next: { value: event, done: false } })
		vi.advanceTimersByTime(1_000)
		expect(expire).not.toHaveBeenCalled()
		turn.close()
		await turn.drain()
	})

	it('still expires at its deadline when a buffered notification does not end the wait', async () => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		await turn.wait(turn.signal)
		turn.start(source(notifications[0]!))
		await turn.wait(turn.signal)
		const expire = vi.fn(() => turn.abort(new Error('Client wait expired.')))
		turn.detach(1_000, expire)
		vi.advanceTimersByTime(999)
		expect(expire).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(expire).toHaveBeenCalledOnce()
		await expect(answer).resolves.toMatchObject({ action: 'abort' })
		turn.close()
		await turn.drain()
		expect(vi.getTimerCount()).toBe(0)
	})

	const ended: SessionEvent[] = [
		{
			type: 'tool_completed',
			sessionId: SESSION,
			turnId: TURN,
			toolUseId: TOOL,
			toolName: 'ask',
			result: 'No longer waiting.',
			isError: true,
		},
		{
			type: 'user_question_answered',
			sessionId: SESSION,
			turnId: TURN,
			checkpointId: CHECKPOINT,
			answered: false,
		},
		{
			type: 'turn_paused',
			sessionId: SESSION,
			turnId: TURN,
			checkpointId: CHECKPOINT,
			reason: 'The native turn moved to a durable pause.',
		},
	]

	it.each(ended)('expires when $type proves the announced wait ended', async (event) => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		await turn.wait(turn.signal)
		const gate = deferred()
		turn.start(source(event, gate.promise))
		const expire = vi.fn(() => turn.abort(new Error('Native wait ended.')))
		turn.detach(1_000, expire)
		gate.resolve()
		await turn.wait(turn.signal)
		expect(expire).toHaveBeenCalledOnce()
		await expect(answer).resolves.toMatchObject({ action: 'abort' })
		turn.close()
		await turn.drain()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not mistake a child turn ending for the waiting parent call ending', async () => {
		vi.useFakeTimers()
		const { turn, answer } = waitingTurn()
		await turn.wait(turn.signal)
		turn.start(source({ ...ended[2]!, turnId: CHILD } as SessionEvent))
		await turn.wait(turn.signal)
		const expire = vi.fn()
		turn.detach(1_000, expire)
		expect(turn.progressed).toBe(false)
		expect(expire).not.toHaveBeenCalled()
		turn.close()
		await answer
		await turn.drain()
	})

	it.each(['eof', 'error'] as const)(
		'expires when the native source ends with $0',
		async (ending) => {
			vi.useFakeTimers()
			const { turn, answer } = waitingTurn()
			await turn.wait(turn.signal)
			const gate = deferred()
			const failure = new Error('Native producer failed.')
			turn.start(
				// biome-ignore lint/correctness/useYield: This fixture deliberately ends before producing an event.
				(async function* (): AsyncGenerator<SessionEvent, Turn> {
					await gate.promise
					if (ending === 'error') throw failure
					return {} as Turn
				})(),
			)
			const expire = vi.fn(() => turn.abort(failure))
			turn.detach(1_000, expire)
			gate.resolve()
			await turn.wait(turn.signal)
			expect(turn.progressed).toBe(true)
			expect(expire).toHaveBeenCalledOnce()
			await expect(answer).resolves.toMatchObject({ action: 'abort' })
			turn.close()
			await turn.drain()
			expect(vi.getTimerCount()).toBe(0)
		},
	)
})
