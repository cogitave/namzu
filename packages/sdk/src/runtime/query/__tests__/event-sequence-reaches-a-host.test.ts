import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { RunPersistence } from '../../../manager/run/persistence.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import { EventTranslator } from '../events.js'
import { type QueryParams, query } from '../index.js'

/**
 * A cursor is only worth having if it reaches the surface a host actually
 * consumes. `query()` is that surface — it yields the run's events — so these
 * drive it rather than the translator underneath, and every assertion here is
 * one the wiring can be deleted to break.
 *
 * The property under test is one sentence: **a `seq` on an event is the
 * statement that this event is in the durable log.** Everything else — the
 * catch-up, the verdict, the wire id — is built on it being true.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-seq-'))
	dirs.push(dir)
	return dir
}

/** The real class over the injected store — the shape production builds. */
function persistence(runStore: InMemoryRunStore, runId: string): RunPersistence {
	return new RunPersistence({
		runId,
		agentId: 'a',
		agentName: 'A',
		runConfig: {},
		providerId: 'mock',
		// Nothing may be written: the injected store is not a filesystem.
		outputDir: '/namzu-nonexistent-should-never-be-written',
		log: LOG,
		sessionId: 'ses_seq',
		topicId: 'top_seq',
		projectId: 'prj_seq',
		tenantId: 'tnt_seq',
		runStore,
		// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
	} as any)
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
 * A run with a tool call in it, so the stream carries more than one lifecycle
 * event and the numbering has something to be wrong about.
 */
async function params(runStore: InMemoryRunStore): Promise<QueryParams> {
	return {
		messages: [createUserMessage('go')],
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		}),
		tools: registryWithEcho(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_seq',
		agentName: 'Sequence Agent',
		workingDirectory: await workdir(),
		sessionId: 'ses_seq',
		topicId: 'top_seq',
		projectId: 'prj_seq',
		tenantId: 'tnt_seq',
		runStore,
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as QueryParams
}

async function drain(p: QueryParams): Promise<RunEvent[]> {
	const seen: RunEvent[] = []
	const gen = query(p)
	let next = await gen.next()
	while (!next.done) {
		seen.push(next.value)
		next = await gen.next()
	}
	return seen
}

describe('a host watching a run gets a cursor with it', () => {
	it('numbers the events it yields, from one, with no gap', async () => {
		const store = new InMemoryRunStore()

		const seen = await drain(await params(store))

		const numbers = seen.filter((e) => e.seq !== undefined).map((e) => e.seq as number)
		expect(numbers.length).toBeGreaterThan(3)
		expect(numbers).toEqual(numbers.map((_, i) => i + 1))
	})

	it('numbers exactly the events the log holds, and gives them the same numbers', async () => {
		const store = new InMemoryRunStore()

		const seen = await drain(await params(store))
		const recorded = await store.readEvents()

		// The two halves of the invariant, and both are needed: the same COUNT
		// would pass if the numbering were shifted, and the same NUMBERS would
		// pass if the live stream carried an event the log never took.
		expect(seen.filter((e) => e.seq !== undefined).map((e) => e.seq)).toEqual(
			recorded.map((e) => e.seq),
		)
		expect(seen.filter((e) => e.seq !== undefined).map((e) => e.type)).toEqual(
			recorded.map((e) => e.type),
		)
	})

	it('leaves the events that are never persisted unnumbered', async () => {
		const store = new InMemoryRunStore()

		const seen = await drain(await params(store))

		// A number on one of these would be a cursor pointing at nothing: the
		// deltas are excluded from the log by design, so a consumer that advanced
		// to one and reconnected would ask for events above a sequence the log
		// has never heard of.
		const ephemeralWithSeq = seen.filter((e) => isEphemeralEvent(e) && e.seq !== undefined)
		expect(ephemeralWithSeq).toEqual([])
	})

	it('carries the claim fence as the generation on every recorded event', async () => {
		const store = new InMemoryRunStore()

		const seen = await drain({ ...(await params(store)), claimFence: 7 } as QueryParams)

		const recorded = seen.filter((e) => e.seq !== undefined)
		expect(recorded.length).toBeGreaterThan(0)
		// Without this a takeover is invisible: the next holder's log restarts at
		// 1 and a consumer at 400 is told, truthfully and uselessly, that there
		// is nothing above it.
		expect(recorded.every((e) => e.generation === 7)).toBe(true)
	})

	it('leaves the generation absent on an unclaimed run rather than inventing one', async () => {
		const store = new InMemoryRunStore()

		const seen = await drain(await params(store))

		expect(seen.every((e) => e.generation === undefined)).toBe(true)
	})
})

describe('the number is a claim that the event is recoverable', () => {
	it('withholds it when the durable write fails, and still delivers the event', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('run_fail')
		const mgr = persistence(store, 'run_fail')
		await mgr.init()
		const emitter = new EventTranslator(mgr)

		vi.spyOn(store, 'appendEvent').mockRejectedValueOnce(new Error('disk full'))
		await expect(
			emitter.emitEvent({ type: 'run_started', runId: fixtureId.run('fail') } as RunEvent),
		).rejects.toThrow('disk full')
		// The next event must take the number the failed one did NOT consume.
		await emitter.emitEvent({ type: 'iteration_started', runId: 'run_fail', iteration: 1 } as never)

		const drained = [...emitter.drainPending()]

		// Delivered, because losing the news of a failure is worse than
		// delivering it without a cursor — and unnumbered, because it is not in
		// the log and a consumer must never advance a cursor onto it.
		expect(drained.map((e) => [e.type, e.seq])).toEqual([
			['run_started', undefined],
			['iteration_started', 1],
		])
		expect((await store.readEvents()).map((e) => e.type)).toEqual(['iteration_started'])
	})
})

describe('emits that overlap still get distinct numbers', () => {
	it('gives twenty concurrent emits twenty consecutive numbers', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('run_race')
		const mgr = persistence(store, 'run_race')
		await mgr.init()
		const emitter = new EventTranslator(mgr)

		// Emits genuinely interleave in production — the task store, the plan
		// manager and a batch of parallel tools all reach this one funnel — and
		// a store whose write yields is enough to interleave them. Without the
		// append lock this measured three events holding 15 and two holding 12.
		const slow = vi
			.spyOn(store, 'appendEvent')
			.mockImplementation(async () => new Promise<void>((r) => setTimeout(r, 1)))
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				emitter.emitEvent({ type: 'iteration_started', runId: 'run_race', iteration: i } as never),
			),
		)
		slow.mockRestore()

		const numbers = [...emitter.drainPending()].map((e) => e.seq)

		expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
		expect(new Set(numbers).size).toBe(20)
	})
})

describe('the sequence survives the process that was writing it', () => {
	it('continues the log rather than starting a second sequence inside it', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('run_restart')
		await store.appendEvent({ type: 'run_started', runId: 'run_restart', seq: 1 } as never)
		await store.appendEvent({
			type: 'iteration_started',
			runId: fixtureId.run('restart'),
			iteration: 1,
			seq: 2,
		})

		// A different `RunPersistence` over the same store is what a second
		// process is: the object graph is new, the log is not.
		const mgr = persistence(store, 'run_restart')
		await mgr.init()

		// Without the seed this is 1, and the log then holds two events numbered
		// 1 and two numbered 2 — so a consumer asking for everything above 2 is
		// handed the run's own beginning a second time.
		expect(mgr.nextEventSeq()).toBe(3)
	})
})
