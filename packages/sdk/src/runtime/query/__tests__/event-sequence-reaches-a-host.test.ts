import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import {
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../../store/session-log/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { isEphemeralEvent } from '../../../types/session/events.js'
import { PERSISTED_SESSION_EVENT_TYPES } from '../../../types/session/records.js'
import { generateTurnId } from '../../../utils/id.js'
import { EventTranslator } from '../events.js'
import { type QueryParams, drainQuery, query } from '../index.js'
import { records } from './support/session.js'

/**
 * A cursor is only worth having if it reaches the surface a host actually
 * consumes. `query()` is that surface — it yields the turn's events — so these
 * drive it rather than the translator underneath, and every assertion here is
 * one the wiring can be deleted to break.
 *
 * The property under test is one sentence: **a `seq` on an event is the
 * statement that this event is in the session log, as the record with that
 * `seq`.** Everything else — the catch-up, the verdict, the wire id — is built
 * on it being true. The log also holds records that are not events (messages,
 * checkpoints), so the numbers a host sees climb with gaps.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const SESSION = '1b9fa4ed-2300-43ac-9ee1-c641c9ae66d1' as SessionId
const SCOPE = {
	sessionId: SESSION,
	topicId: '07c17470-7e89-4c5e-9680-2d10d92ac22a',
	projectId: '4dfa889d-312b-4570-a8e3-e1ccd3f2274b',
	tenantId: '2c8e25c0-8fc7-4427-8e9e-f338d6e51c02',
}

const EVENT_TYPES: ReadonlySet<string> = new Set(PERSISTED_SESSION_EVENT_TYPES)

const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(dirs)
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-seq-'))
	dirs.push(dir)
	return dir
}

/** The real class over the given log — the shape production builds. */
function recorderOver(sessionLog: SessionLog, turnId: TurnId = generateTurnId()): TurnRecorder {
	return new TurnRecorder({
		turnId,
		agentId: 'a',
		agentName: 'A',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log: LOG,
		...SCOPE,
		sessionLog,
		// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
	} as any)
}

/** A recorder whose turn has begun, and the translator in front of it. */
async function begunTurn(sessionLog: SessionLog) {
	const recorder = recorderOver(sessionLog)
	await recorder.open({ session: { cwd: '/tmp' } })
	const emitter = new EventTranslator(recorder)
	await emitter.beginTurn({})
	recorder.markRunning()
	;[...emitter.drainPending()]
	return { recorder, emitter }
}

function latch() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function registryWithEcho(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
	return tools
}

/**
 * A turn with a tool call in it, so the stream carries more than one
 * lifecycle event and the numbering has something to be wrong about.
 */
async function params(sessionLog: SessionLog): Promise<QueryParams> {
	return {
		messages: [createUserMessage('go')],
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		}),
		tools: registryWithEcho(),
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_seq',
		agentName: 'Sequence Agent',
		workingDirectory: await workdir(),
		...SCOPE,
		sessionLog,
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as QueryParams
}

async function drain(p: QueryParams): Promise<SessionEvent[]> {
	const seen: SessionEvent[] = []
	const gen = query(p)
	let next = await gen.next()
	while (!next.done) {
		seen.push(next.value)
		next = await gen.next()
	}
	return seen
}

const memoryLog = () => new InMemorySessionLog({ sessionId: SESSION })

describe('a host watching a turn gets a cursor with it', () => {
	it('numbers the events it yields in log order, never twice', async () => {
		const seen = await drain(await params(memoryLog()))

		const numbers = seen.filter((e) => e.seq !== undefined).map((e) => e.seq as number)
		expect(numbers.length).toBeGreaterThan(3)
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
		expect(new Set(numbers).size).toBe(numbers.length)
	})

	it('numbers exactly the events the log holds, and gives them the same numbers', async () => {
		const sessionLog = memoryLog()
		const seen = await drain(await params(sessionLog))
		const recorded = (await records(sessionLog)).filter((record) => EVENT_TYPES.has(record.type))

		// The two halves of the invariant, and both are needed: the same COUNT
		// would pass if the numbering were shifted, and the same NUMBERS would
		// pass if the live stream carried an event the log never took.
		const numbered = seen.filter((e) => e.seq !== undefined)
		expect(numbered.map((e) => e.seq)).toEqual(recorded.map((record) => record.seq))
		expect(numbered.map((e) => e.type)).toEqual(recorded.map((record) => record.type))
	})

	it('leaves the events that are never persisted unnumbered', async () => {
		const seen = await drain(await params(memoryLog()))

		// A number on one of these would be a cursor pointing at nothing: the
		// deltas are excluded from the log by design, so a consumer that advanced
		// to one and reconnected would ask for events above a sequence the log
		// has never heard of.
		const ephemeralWithSeq = seen.filter((e) => isEphemeralEvent(e) && e.seq !== undefined)
		expect(ephemeralWithSeq).toEqual([])
	})

	it('carries the lease fence as the generation on every recorded event', async () => {
		const sessionLog = memoryLog()
		// Two earlier holdings, so the fence this turn writes under is not 1.
		for (const holder of ['earlier-1', 'earlier-2']) {
			const earlier = (await sessionLog.claim({ holder, ttlMs: 60_000 })) as SessionLease
			await sessionLog.release(earlier)
		}
		const lease = (await sessionLog.claim({ holder: 'worker', ttlMs: 60_000 })) as SessionLease

		const seen = await drain({ ...(await params(sessionLog)), lease } as QueryParams)

		const recorded = seen.filter((e) => e.seq !== undefined)
		expect(recorded.length).toBeGreaterThan(0)
		// Without this a takeover is invisible: a consumer at 400 is told,
		// truthfully and uselessly, that there is nothing above it.
		expect(lease.fence).toBeGreaterThan(1)
		expect(recorded.every((e) => e.generation === lease.fence)).toBe(true)
	})
})

describe('the number is a claim that the event is recoverable', () => {
	it('withholds it when the append fails, and still delivers the event', async () => {
		const sessionLog = memoryLog()
		const { emitter, recorder } = await begunTurn(sessionLog)

		vi.spyOn(sessionLog, 'append').mockRejectedValueOnce(new Error('disk full'))
		await expect(
			emitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never),
		).rejects.toThrow('disk full')
		// A log whose append failed is in a state nobody verified: the recorder
		// takes no further records, so the next event is refused as well.
		await expect(
			emitter.emitEvent({ type: 'iteration_started', iteration: 2 } as never),
		).rejects.toThrow('disk full')

		const drained = [...emitter.drainPending()]

		// Delivered, because losing the news of a failure is worse than
		// delivering it without a cursor — and unnumbered, because neither is
		// in the log and a consumer must never advance a cursor onto them.
		expect(drained.map((e) => [e.type, e.seq])).toEqual([
			['iteration_started', undefined],
			['iteration_started', undefined],
		])
		expect(
			(await records(sessionLog)).filter((record) => record.type === 'iteration_started'),
		).toEqual([])
		expect(recorder.turnId).toBeDefined()
	})
})

describe('emits that overlap still get distinct numbers', () => {
	it('gives twenty concurrent emits twenty consecutive numbers', async () => {
		const sessionLog = memoryLog()
		const { emitter } = await begunTurn(sessionLog)
		const head = (await sessionLog.head())?.pointer.seq ?? 0

		// Emits genuinely interleave in production — the task store, the plan
		// manager and a batch of parallel tools all reach this one funnel — and
		// a log whose write yields is enough to interleave them.
		const append = sessionLog.append.bind(sessionLog)
		vi.spyOn(sessionLog, 'append').mockImplementation(async (lease, draft) => {
			await new Promise<void>((r) => setTimeout(r, 1))
			return append(lease, draft)
		})
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				emitter.emitEvent({ type: 'iteration_started', iteration: i } as never),
			),
		)

		const numbers = [...emitter.drainPending()].map((e) => e.seq)

		expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => head + 1 + i))
	})
})

describe('a live log snapshot stays between whole appends', () => {
	it('cancels a queued capture before a blocked append finishes without reading the log', async () => {
		const sessionLog = memoryLog()
		const { emitter, recorder } = await begunTurn(sessionLog)
		const entered = latch()
		const release = latch()
		const append = sessionLog.append.bind(sessionLog)
		vi.spyOn(sessionLog, 'append').mockImplementationOnce(async (lease, draft) => {
			entered.resolve()
			await release.promise
			return append(lease, draft)
		})
		const head = vi.spyOn(recorder, 'head')
		const writing = emitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never)
		await entered.promise
		const local = new AbortController()
		const capture = emitter.captureSessionEvidence(undefined, local.signal)
		local.abort(new Error('cancel queued read'))
		try {
			await expect(capture).rejects.toThrow('cancel queued read')
			expect(head).not.toHaveBeenCalled()
		} finally {
			release.resolve()
		}
		await writing
		// An in-memory log has no retained text: the capture answers `undefined`.
		await expect(emitter.captureSessionEvidence()).resolves.toBeUndefined()
		expect(head).toHaveBeenCalledTimes(1)
	})

	it('rejects a cancelled capture promptly but keeps its lock until the read settles', async () => {
		const sessionLog = memoryLog()
		const { emitter, recorder } = await begunTurn(sessionLog)
		const entered = latch()
		const release = latch()
		vi.spyOn(recorder, 'head').mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			throw new Error('late backend failure')
		})
		const local = new AbortController()
		const capture = emitter.captureSessionEvidence(undefined, local.signal)
		await entered.promise
		const append = vi.spyOn(sessionLog, 'append')
		const writing = emitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never)
		local.abort(new Error('cancel active read'))
		try {
			await expect(capture).rejects.toThrow('cancel active read')
			expect(append).not.toHaveBeenCalled()
		} finally {
			release.resolve()
		}
		await writing
		expect(append).toHaveBeenCalledTimes(1)
	})

	it('waits for an append and holds later appends until the read finishes', async () => {
		const sessionLog = memoryLog()
		const { emitter } = await begunTurn(sessionLog)
		const appending = latch()
		const finishAppend = latch()
		const readStarted = latch()
		const finishRead = latch()
		const realAppend = sessionLog.append.bind(sessionLog)
		const append = vi.spyOn(sessionLog, 'append')
		append.mockImplementationOnce(async (lease, draft) => {
			appending.resolve()
			await finishAppend.promise
			return realAppend(lease, draft)
		})
		const readAll = sessionLog.readAll.bind(sessionLog)
		const read = vi.spyOn(sessionLog, 'readAll').mockImplementationOnce(async (options) => {
			readStarted.resolve()
			await finishRead.promise
			return readAll(options)
		})
		const first = emitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never)
		await appending.promise
		const snapshot = emitter.readRecords({ mode: 'strict' })
		void snapshot.catch(() => {})
		const second = emitter.emitEvent({ type: 'iteration_started', iteration: 2 } as never)
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(read).not.toHaveBeenCalled()
			expect(append).toHaveBeenCalledTimes(1)
			finishAppend.resolve()
			await readStarted.promise
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(append).toHaveBeenCalledTimes(1)
			finishRead.resolve()
			const iterations = (await snapshot).filter((record) => record.type === 'iteration_started')
			expect(iterations).toHaveLength(1)
			await second
			expect(
				(await emitter.readRecords({ mode: 'strict' })).filter(
					(record) => record.type === 'iteration_started',
				),
			).toHaveLength(2)
		} finally {
			finishAppend.resolve()
			finishRead.resolve()
			await Promise.allSettled([first, snapshot, second])
		}
	})

	it('initializes the query tool budget after an in-flight activity append finishes', async () => {
		const sessionLog = memoryLog()
		const appending = latch()
		const finishAppend = latch()
		const snapshotRequested = latch()
		const realAppend = sessionLog.append.bind(sessionLog)
		let held = false
		vi.spyOn(sessionLog, 'append').mockImplementation(async (lease, draft) => {
			const record = draft as { type: string; status?: string }
			if (record.type !== 'activity_updated' || record.status !== 'completed' || held) {
				return realAppend(lease, draft)
			}
			held = true
			appending.resolve()
			await finishAppend.promise
			return realAppend(lease, draft)
		})
		const readSnapshot = EventTranslator.prototype.readRecords
		vi.spyOn(EventTranslator.prototype, 'readRecords').mockImplementation(function (
			this: EventTranslator,
			options,
		) {
			const pending = readSnapshot.call(this, options)
			snapshotRequested.resolve()
			return pending
		})
		let executions = 0
		const tools = new ToolRegistry()
		tools.register({
			name: 'echo',
			description: 'records budgeted execution',
			inputSchema: z.object({ text: z.string() }),
			execute: async () => {
				executions++
				return { success: true, output: 'hi' }
			},
		})
		const running = drainQuery({
			...(await params(sessionLog)),
			tools,
			maxToolCalls: 1,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})
		try {
			await Promise.race([appending.promise, running])
			await Promise.race([snapshotRequested.promise, running])
			finishAppend.resolve()
			const result = await running
			expect(result.status, result.lastError).toBe('completed')
			expect(executions).toBe(1)
		} finally {
			finishAppend.resolve()
			await running.catch(() => {})
		}
	})

	it('releases the queue after a failed read', async () => {
		const sessionLog = memoryLog()
		const { emitter } = await begunTurn(sessionLog)
		await emitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never)
		vi.spyOn(sessionLog, 'readAll').mockRejectedValueOnce(new Error('the log refused the read'))

		await expect(emitter.readRecords({ mode: 'strict' })).rejects.toThrow('refused the read')

		// A failed snapshot must not poison the queue: the next append and the
		// next read both go through.
		await emitter.emitEvent({ type: 'iteration_started', iteration: 2 } as never)
		const after = await emitter.readRecords({ mode: 'strict' })
		expect(
			after
				.filter((record) => record.type === 'iteration_started')
				.map((record) => (record as { iteration?: number }).iteration),
		).toEqual([1, 2])
	})
})

describe('the sequence survives the process that was writing it', () => {
	it('continues the log rather than starting a second sequence inside it', async () => {
		const sessionLog = memoryLog()
		// What the first process left: its session, and a turn it closed.
		const first = recorderOver(sessionLog)
		await first.open({ session: { cwd: '/tmp' } })
		const firstEmitter = new EventTranslator(first)
		await firstEmitter.beginTurn({})
		await firstEmitter.emitEvent({ type: 'iteration_started', iteration: 1 } as never)
		await first.flush()
		await first.release()
		const closer = (await sessionLog.claim({ holder: 'closer', ttlMs: 60_000 })) as SessionLease
		await sessionLog.abandonTurn(closer, first.turnId, 'the first process went away')
		await sessionLog.release(closer)
		const head = (await sessionLog.head())?.pointer.seq ?? 0

		// A different `TurnRecorder` over another instance of the same log is
		// what a second process is: the object graph is new, the log is not.
		const reopened = new InMemorySessionLog({
			sessionId: SESSION,
			medium: sessionLog.medium,
			leases: sessionLog.leaseStore,
			spills: sessionLog.spillStore,
		})
		const second = recorderOver(reopened)
		await second.open({ session: { cwd: '/tmp' } })
		const begun = await second.begin({})

		// Numbered from 1 again, the log would hold two records numbered 1 —
		// so a consumer asking for everything above 2 would be handed the
		// session's own beginning a second time.
		expect(begun.record.seq).toBe(head + 1)
	})
})
