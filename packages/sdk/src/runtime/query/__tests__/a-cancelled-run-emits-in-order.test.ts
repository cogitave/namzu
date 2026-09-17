import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { PluginRegistry } from '../../../registry/plugin/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import { type PendingDecision, autoApproveHandler } from '../../../types/hitl/index.js'
import type { CheckpointId, PluginId } from '../../../types/ids/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import { type CancelCause, RunCancelled } from '../../../types/run/cancel-cause.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { type QueryParams, query } from '../index.js'

/**
 * A cancelled run is the one path where ORDER is the entire contract.
 *
 * A host folds `message_completed` into its transcript and `run_completed`
 * into its run record. A stream that settles the run before it closes the
 * message leaves a card open forever; one that reports `run_failed` for a
 * deliberate Stop puts an operator's keystroke in the error dashboard. And a
 * cancellation nobody attributed arrives as the same bare `'cancelled'` that a
 * budget stop and an abandoned child do, so the reader cannot tell a decision
 * from a fault.
 *
 * Every case drives the REAL `query()`. A hand-built iteration context cannot
 * fail when a wiring line in the loop is deleted — which is exactly the
 * regression class this pins, because the loop checks the abort signal at a
 * dozen separate points and each one settles the run by hand.
 */

function logger(): Logger {
	const make = (): Logger =>
		({
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			child: vi.fn(() => make()),
		}) as unknown as Logger
	return make()
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-cancel-order-'))
	dirs.push(dir)
	return dir
}

function latch() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

/**
 * A {@link CheckpointStore} that can answer the one question an approval queue
 * asks: how many parks are outstanding right now.
 */
class CountingCheckpointStore implements CheckpointStore {
	readonly rows = new Map<string, { id: CheckpointId; pending?: PendingDecision }>()

	async writeCheckpoint(
		_scope: CheckpointRunScope,
		checkpoint: { id: CheckpointId; pending?: PendingDecision },
	): Promise<void> {
		this.rows.set(checkpoint.id, checkpoint)
	}

	async readCheckpoint(_scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<never> {
		return this.rows.get(checkpointId) as never
	}

	async listCheckpoints(_scope: CheckpointRunScope): Promise<never[]> {
		return [...this.rows.values()] as never[]
	}

	async deleteCheckpoint(_scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		this.rows.delete(checkpointId)
	}

	/** Parks with no `resolvedAt` — exactly what `findPendingCheckpoint` serves. */
	pendingCount(): number {
		return [...this.rows.values()].filter(
			(row) => row.pending !== undefined && row.pending.resolvedAt === undefined,
		).length
	}
}

const baseParams = async (overrides: Partial<QueryParams>): Promise<QueryParams> =>
	({
		agentId: 'agent_cancel_order',
		agentName: 'Cancellation order agent',
		messages: [{ role: 'user', content: 'do the work' }],
		workingDirectory: await workdir(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		// What `drainQuery` substitutes. `query()` does not, and a run with no
		// handler fails the moment any park is reached.
		resumeHandler: autoApproveHandler,
		...overrides,
	}) as QueryParams

/**
 * Pull the generator by hand so an abort can land AT a named event.
 *
 * `for await` gives the host no moment between receiving an event and asking
 * for the next one; this does, which is what makes "abort immediately after
 * `iteration_completed`" a fact about the loop rather than a race.
 */
async function drain(
	gen: AsyncGenerator<RunEvent, Run>,
	onEvent?: (event: RunEvent) => void,
): Promise<{ events: RunEvent[]; run: Run }> {
	const events: RunEvent[] = []
	let next = await gen.next()
	while (!next.done) {
		events.push(next.value)
		onEvent?.(next.value)
		next = await gen.next()
	}
	return { events, run: next.value }
}

const types = (events: readonly RunEvent[]): string[] => events.map((event) => event.type)

const onlyOf = <T extends RunEvent['type']>(events: readonly RunEvent[], type: T) =>
	events.filter((event) => event.type === type) as Extract<RunEvent, { type: T }>[]

function registryWithNoop(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'noop',
			description: 'does nothing',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'ok' }),
		}),
	)
	return tools
}

/** Streams a little, then holds the turn open until the caller aborts. */
class HeldTurnProvider implements LLMProvider {
	readonly id = 'held-turn'
	readonly name = 'Held turn'
	readonly capabilities = {
		supportsTools: true,
		supportsStreaming: true,
		supportsFunctionCalling: true,
	}
	readonly entered = latch()

	async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		yield { id: 'm1', delta: { content: 'partial answer' } }
		this.entered.resolve()
		// Never answers. Only the abort can end this turn, which is what makes
		// the abort the thing under test rather than the provider.
		await new Promise<void>(() => {})
	}
}

describe('a run cancelled while the provider held the turn', () => {
	it('closes the message before it settles the run, and never reports a failure', async () => {
		const caller = new AbortController()
		const provider = new HeldTurnProvider()
		const params = await baseParams({ provider, tools: new ToolRegistry(), signal: caller.signal })

		const pending = drain(query(params))
		await provider.entered.promise
		caller.abort(new RunCancelled('user'))
		const { events, run } = await pending

		// The full ordered stream, pinned. A host folds this list into its
		// state in order, so a reordering is a behavioural change even when
		// every event is still present.
		expect(types(events)).toEqual([
			'run_started',
			'activity_created',
			'activity_updated',
			'iteration_started',
			'request_envelope',
			'message_started',
			'text_delta',
			'message_completed',
			'run_completed',
		])

		// A deliberate Stop is a decision, not a fault — and the error path
		// records one in the audit trail and the error dashboard as such.
		expect(events.some((event) => event.type === 'run_failed')).toBe(false)

		const completed = onlyOf(events, 'run_completed')
		expect(completed).toHaveLength(1)

		const messageCompleted = events.findIndex((event) => event.type === 'message_completed')
		const runCompleted = events.findIndex((event) => event.type === 'run_completed')
		expect(messageCompleted).toBeGreaterThanOrEqual(0)
		expect(events[messageCompleted]).toMatchObject({
			stopReason: 'cancelled',
			content: 'partial answer',
		})
		// The message must be closed BEFORE the run is settled, or a host that
		// renders on `run_completed` draws a card with no terminator — and the
		// partial text the model already produced is lost with it.
		expect(messageCompleted).toBeLessThan(runCompleted)

		expect(completed[0]).toMatchObject({ stopReason: 'cancelled', cancelCause: 'user' })
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
	})
})

describe('a run cancelled between one iteration and the next', () => {
	it('settles once, after the iteration it interrupted has reported', async () => {
		const caller = new AbortController()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'noop', args: {} }], finishReason: 'tool_calls' },
				{ text: 'never reached' },
			],
		})

		const params = await baseParams({
			provider,
			tools: registryWithNoop(),
			signal: caller.signal,
		})
		const { events, run } = await drain(query(params), (event) => {
			// The loop emits `iteration_completed` and only then asks whether it
			// was aborted. Landing the Stop here is exactly the window between
			// the two — and the loop breaks out of the `for` at that point,
			// which is the boundary a cancelled run crosses.
			if (event.type === 'iteration_completed' && !caller.signal.aborted) {
				caller.abort(new RunCancelled('user'))
			}
		})

		expect(onlyOf(events, 'run_completed')).toHaveLength(1)
		expect(events.some((event) => event.type === 'run_failed')).toBe(false)
		expect(types(events).at(-1)).toBe('run_completed')
		// The iteration that was interrupted still reports itself: a host
		// counting steps must not lose the one that was already paid for.
		expect(types(events).indexOf('iteration_completed')).toBeLessThan(
			types(events).indexOf('run_completed'),
		)
		// And the run did not go round again — the turn after the abort is the
		// cancellation's whole point.
		expect(provider.requests).toHaveLength(1)
		expect(run.status).toBe('cancelled')
	})
})

describe('a Stop that arrives while the run is parked on a tool review', () => {
	/** A destructive call no gate pre-approves, so it reaches a human. */
	function reviewFixture() {
		const executed: string[] = []
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'deploy',
				description: 'a destructive call that needs a human',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					executed.push('deploy')
					return { success: true, output: 'deployed' }
				},
			}),
		)
		return { tools, executed }
	}

	const reviewGate = {
		enabled: true,
		rules: [],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
	}

	it('resolves the park as cancelled rather than waiting for the host to answer', async () => {
		const caller = new AbortController()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' }],
		})
		const { tools, executed } = reviewFixture()

		const asked = latch()
		const events: RunEvent[] = []
		const params = await baseParams({
			provider,
			tools,
			signal: caller.signal,
			// Zero so the review is written down as a durable park promptly;
			// the wait the Stop has to interrupt is the host's, and it never
			// ends on its own.
			parkRecordDelayMs: 0,
			authorizationGate: reviewGate,
			resumeHandler: () => {
				asked.resolve()
				// The host is never going to answer. If the park were not
				// cancellable this run would hang here until the test timed out.
				return new Promise(() => {})
			},
		} as Partial<QueryParams>)

		const pending = drain(query(params), (event) => {
			events.push(event)
		})
		await asked.promise
		caller.abort(new RunCancelled('user'))

		const { run } = await pending

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		// Nothing was approved, so nothing ran.
		expect(executed).toEqual([])
		expect(onlyOf(events, 'run_completed')).toHaveLength(1)
		expect(events.some((event) => event.type === 'run_failed')).toBe(false)
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'tool_review_completed', decision: 'rejected' }),
		)
	})

	it('leaves the durable park it recorded resolved, not outstanding', async () => {
		const caller = new AbortController()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' }],
		})
		const { tools } = reviewFixture()
		const store = new CountingCheckpointStore()

		const asked = latch()
		const params = await baseParams({
			provider,
			tools,
			checkpointStore: store,
			signal: caller.signal,
			parkRecordDelayMs: 0,
			authorizationGate: reviewGate,
			resumeHandler: () => {
				asked.resolve()
				return new Promise(() => {})
			},
		} as Partial<QueryParams>)

		const pending = drain(query(params))
		await asked.promise
		// Wait for the write rather than for a duration: what makes this a
		// run-level claim is that the park is on the durable record at all.
		await vi.waitFor(() => expect(store.pendingCount()).toBeGreaterThan(0))
		caller.abort(new RunCancelled('user'))
		await pending

		// An approval queue built from durable state must stop re-serving a
		// park nobody is waiting on any more.
		expect(store.pendingCount()).toBe(0)
	})
})

describe('the in-iteration abort checkpoints', () => {
	/**
	 * The loop samples the abort signal at a dozen separate points inside one
	 * iteration and each one settles the run by hand. Two of them settling —
	 * or one of them failing to — is invisible in a single-event assertion, so
	 * the invariant is asserted at every point a real run can be reached.
	 */
	const cases: Array<{ name: string; abortAfter: RunEvent['type'] }> = [
		{ name: 'a completed tool batch', abortAfter: 'tool_completed' },
		{ name: 'a review decision', abortAfter: 'tool_review_completed' },
		{ name: 'a durable checkpoint', abortAfter: 'checkpoint_created' },
		{ name: 'a closed message', abortAfter: 'message_completed' },
		{ name: 'a reported iteration', abortAfter: 'iteration_completed' },
	]

	for (const { name, abortAfter } of cases) {
		it(`settles the run exactly once when the Stop lands after ${name}`, async () => {
			const caller = new AbortController()
			const provider = new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'c1', name: 'noop', args: {} }], finishReason: 'tool_calls' },
					{ text: 'done' },
				],
			})

			const params = await baseParams({
				provider,
				tools: registryWithNoop(),
				signal: caller.signal,
			})
			const { events, run } = await drain(query(params), (event) => {
				if (event.type === abortAfter && !caller.signal.aborted) {
					caller.abort(new RunCancelled('user'))
				}
			})

			expect(onlyOf(events, 'run_completed')).toHaveLength(1)
			expect(events.some((event) => event.type === 'run_failed')).toBe(false)
			expect(run.status).toBe('cancelled')
			expect(types(events).at(-1)).toBe('run_completed')
		})
	}
})

describe('why a run was cancelled', () => {
	function managerWithInterruptHook(id: string, seen: unknown[]): PluginLifecycleManager {
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			toolRegistry: new ToolRegistry(),
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
			hookTimeoutMs: 5_000,
		})
		manager.registerHook(id as PluginId, {
			event: 'run_interrupt',
			handler: async (context) => {
				seen.push((context as { cancelCause?: string }).cancelCause)
				return { action: 'continue' }
			},
		})
		return manager
	}

	const nonUserCauses: CancelCause[] = ['parent', 'budget', 'hook']

	for (const cause of nonUserCauses) {
		it(`records cancelCause: '${cause}' and leaves the user-interrupt hooks alone`, async () => {
			const caller = new AbortController()
			const seen: unknown[] = []
			const manager = managerWithInterruptHook(`plugin_interrupt_${cause}`, seen)
			const params = await baseParams({
				provider: new MockLLMProvider({ responseText: 'the answer' }),
				tools: new ToolRegistry(),
				pluginManager: manager,
				signal: caller.signal,
			})

			const { events } = await drain(query(params), () => {
				if (!caller.signal.aborted) caller.abort(new RunCancelled(cause))
			})

			const completed = onlyOf(events, 'run_completed')
			expect(completed).toHaveLength(1)
			// The cause is the difference between an operator pressing Stop and
			// a parent abandoning a child; without it a reader investigates the
			// wrong thing.
			expect(completed[0]).toMatchObject({ stopReason: 'cancelled', cancelCause: cause })
			// `run_interrupt` is the OPERATOR's cleanup channel. A parent
			// abandoning a child, a budget stop, a hook's own refusal: none of
			// those is an operator interrupt, and firing it for them runs a
			// host's cleanup against a run nobody stopped.
			expect(seen).toEqual([])
		})
	}

	it('fires the user-interrupt hooks when the cause IS the user', async () => {
		// The premise behind the three cases above: the hooks are reachable, so
		// their silence there is a decision rather than a broken fixture.
		const caller = new AbortController()
		const seen: unknown[] = []
		const manager = managerWithInterruptHook('plugin_interrupt_user', seen)
		const params = await baseParams({
			provider: new MockLLMProvider({ responseText: 'the answer' }),
			tools: new ToolRegistry(),
			pluginManager: manager,
			signal: caller.signal,
		})

		const { events } = await drain(query(params), () => {
			if (!caller.signal.aborted) caller.abort(new RunCancelled('user'))
		})

		expect(onlyOf(events, 'run_completed')[0]).toMatchObject({ cancelCause: 'user' })
		expect(seen).toEqual(['user'])
	})

	it('leaves cancelCause absent when nobody attributed the cancellation', async () => {
		const caller = new AbortController()
		const params = await baseParams({
			provider: new MockLLMProvider({ responseText: 'the answer' }),
			tools: new ToolRegistry(),
			signal: caller.signal,
		})

		const { events } = await drain(query(params), () => {
			// A bare abort — no reason at all, which is what
			// `AbstractAgent.cancel()` used to send.
			if (!caller.signal.aborted) caller.abort()
		})

		const completed = onlyOf(events, 'run_completed')
		expect(completed).toHaveLength(1)
		// `undefined` is a real answer: a cancellation nobody attributed is not
		// a user cancellation, and defaulting would put a confident wrong value
		// where an honest absence belongs.
		expect(completed[0]?.cancelCause).toBeUndefined()
	})
})
