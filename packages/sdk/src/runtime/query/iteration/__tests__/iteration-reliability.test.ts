// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - A post-success abort accounts usage + fires token_usage_updated but pushes
//   NO assistant message and executes NO tools; the run ends 'cancelled' and its
//   history is repaired (dangling tool calls healed) in place.
// - finishReason 'length' WITH tool calls sanitizes invalid JSON arguments to
//   '{}', pushes one synthesized not-executed tool result per call (never
//   executing the tools), completes the iteration through the normal tail, and
//   continues; WITHOUT tool calls it warns and ends the turn.
// - A context_overflow provider error is recovered by reducing history and
//   reissuing within the same iteration; when the reducer cannot shrink, the
//   run fails and the history is left untouched (candidate-first no-commit).
//
// Current-code invariants asserted (2026-07-12, ses_015 fix-batch):
// - The deadline-timeout classification in the iteration catch is gated on BOTH
//   halves of `isDeadlineTimeoutStop`: the deadline must have passed AND the error
//   must be a retryable transport kind (throttle/server/network). A retryable error
//   that exhausts its retries while the budget is healthy FAILS the run; a
//   post-deadline auth/bad_request/context_overflow error keeps the normal failure
//   path with the ORIGINAL error preserved rather than being masked as a timeout.
//
// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze B2):
// - A provider that never answers cannot hold the run past timeoutMs: the model
//   call itself races the deadline, not merely the attempt count, and the run
//   stops as 'timeout'.
//
// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze R3):
// - B2 has a consequence for THIS suite: an error a provider reports after the
//   deadline is never observed by the loop, so no fake provider can drive the
//   gate's post-deadline branch end-to-end. The gate is therefore asserted
//   directly on `isDeadlineTimeoutStop`, and each half is pinned by a test that
//   fails when that half is dropped.
//
// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze R5):
// - A post-success abort and a mid-call abort are distinct. The first accounts the
//   completed call's usage and fires token_usage_updated; the second settles the
//   model call the moment the abort lands, so the response never reaches the loop
//   and there is no usage to account. Both end the run 'cancelled' with no assistant
//   message, no tools executed, and no llm_response event.
// These tests drive the real query() loop with hand-rolled fake providers.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { ProviderRequestError } from '../../../../provider/errors.js'
import { ToolRegistry } from '../../../../registry/tool/execute.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	type ToolMessage,
	createAssistantMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../../types/provider/index.js'
import type { AgentRunConfig, Run, RunEvent } from '../../../../types/run/index.js'
import { drainQuery } from '../../index.js'
import { isDeadlineTimeoutStop } from '../index.js'

interface FakeProvider extends LLMProvider {
	calls: number
}

function makeProvider(
	chat: (params: ChatCompletionParams, call: number) => Promise<ChatCompletionResponse>,
): FakeProvider {
	const provider: FakeProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			const index = provider.calls
			provider.calls += 1
			return chat(params, index)
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

const USAGE = { promptTokens: 5, completionTokens: 5, totalTokens: 10 }

function stopResponse(content: string): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content },
		finishReason: 'stop',
		usage: USAGE,
	} as ChatCompletionResponse
}

function toolResponse(
	id: string,
	args: string,
	finishReason: ChatCompletionResponse['finishReason'] = 'tool_calls',
): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id, type: 'function', function: { name: 'foo', arguments: args } }],
		},
		finishReason,
		usage: USAGE,
	} as ChatCompletionResponse
}

function lengthResponseNoTools(content: string): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content },
		finishReason: 'length',
		usage: USAGE,
	} as ChatCompletionResponse
}

const dirs: string[] = []

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-ses015-'))
	dirs.push(dir)
	return dir
}

async function runQuery(opts: {
	provider: LLMProvider
	messages: Message[]
	signal?: AbortSignal
	runConfig?: Partial<AgentRunConfig>
	/**
	 * Observe events as the loop emits them. The only handle a test has on the
	 * INSIDE of a run: `drainQuery` is awaited as a whole, so a hook that has to
	 * fire at a specific point mid-iteration has nowhere else to hang.
	 */
	onEvent?: (event: RunEvent) => void
}): Promise<{ run: Run; events: RunEvent[] }> {
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: new ToolRegistry(),
			runConfig: {
				model: 'm',
				tokenBudget: 1_000_000,
				timeoutMs: 600_000,
				maxIterations: 50,
				temperature: 0.3,
				...opts.runConfig,
			},
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: tmp(),
			messages: opts.messages,
			signal: opts.signal,
			sessionId: 'ses_test' as SessionId,
			threadId: 'thr_test' as ThreadId,
			projectId: 'prj_test' as ProjectId,
			tenantId: 'tnt_test' as TenantId,
		},
		(e) => {
			events.push(e)
			opts.onEvent?.(e)
		},
	)
	return { run, events }
}

afterEach(() => {
	dirs.length = 0
})

describe('iteration loop — post-success abort', () => {
	it('accounts usage, skips the assistant push, and cancels', async () => {
		// A post-SUCCESS abort: the response reached the loop, its usage was accounted,
		// and the cancel lands before the loop acts on the content. `token_usage_updated`
		// is the loop's own marker for "the call is accounted for", so aborting on it
		// puts the cancel exactly in that window without racing a timer for it.
		const ctrl = new AbortController()
		const provider = makeProvider(async () => toolResponse('c1', '{}'))

		const { run, events } = await runQuery({
			provider,
			messages: [createUserMessage('hello')],
			signal: ctrl.signal,
			onEvent: (e) => {
				if (e.type === 'token_usage_updated') ctrl.abort()
			},
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.calls).toBe(1)
		expect(run.messages.some((m) => m.role === 'assistant')).toBe(false)
		// The tokens were spent and the observer sees them; the content they paid for
		// is still not acted on.
		expect(events.some((e) => e.type === 'token_usage_updated')).toBe(true)
		expect(events.some((e) => e.type === 'llm_response')).toBe(false)
	})

	// ses_015 pre-freeze R5 B1. The abort above lands AFTER the call completed. An
	// abort that lands while the call is still in flight is a different case with a
	// different answer, and the two were previously conflated: the model call
	// deferred its abort rejection through a timer, which let a provider resolving in
	// the same tick win the race and be treated as a completed call.
	//
	// It is not one. Cancellation settles the call the moment it lands, so a response
	// the provider produces afterwards is discarded — no assistant message, no tools,
	// and no usage accounting, because the loop never receives the response to account
	// (the same trade already made for a response that arrives after the deadline
	// abandons the wait: on an adapter that ignores the signal those tokens are billed
	// and unaccounted, and buying them back would mean letting a cancelled run keep
	// mutating its own totals).
	it('discards the response when the abort lands mid-call, and still cancels cleanly', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => {
			ctrl.abort()
			return toolResponse('c1', '{}')
		})

		const { run, events } = await runQuery({
			provider,
			messages: [createUserMessage('hello')],
			signal: ctrl.signal,
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.calls).toBe(1)
		expect(run.messages.some((m) => m.role === 'assistant')).toBe(false)
		expect(events.some((e) => e.type === 'llm_response')).toBe(false)
		// The response never reached the loop, so there is nothing to account.
		expect(events.some((e) => e.type === 'token_usage_updated')).toBe(false)
	})

	it('repairs a dangling tool call in the run history on cancellation', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => {
			ctrl.abort()
			return stopResponse('ignored')
		})
		const dangling: AssistantMessage = createAssistantMessage(null, [
			{ id: 'call_x', type: 'function', function: { name: 'foo', arguments: '{}' } },
		])

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi'), dangling],
			signal: ctrl.signal,
		})

		expect(run.status).toBe('cancelled')
		const toolMsg = run.messages.find(
			(m): m is ToolMessage => m.role === 'tool' && (m as ToolMessage).toolCallId === 'call_x',
		)
		expect(toolMsg).toBeDefined()
		expect(toolMsg?.content).toContain('Tool result missing')
		expect(findDanglingMessages(run.messages).isValid).toBe(true)
	})
})

describe('iteration loop — finishReason length', () => {
	it('sanitizes truncated tool args, synthesizes not-executed results, and continues', async () => {
		const provider = makeProvider(async (_p, call) => {
			if (call === 0) return toolResponse('c1', '{"a":', 'length') // invalid JSON args
			return stopResponse('done')
		})

		const { run, events } = await runQuery({
			provider,
			messages: [createUserMessage('go')],
		})

		expect(provider.calls).toBe(2)
		expect(run.status).toBe('completed')

		const assistantWithTool = run.messages.find(
			(m): m is AssistantMessage => m.role === 'assistant' && !!(m as AssistantMessage).toolCalls,
		)
		expect(assistantWithTool?.toolCalls?.[0]?.function.arguments).toBe('{}')

		const toolMsg = run.messages.find(
			(m): m is ToolMessage => m.role === 'tool' && (m as ToolMessage).toolCallId === 'c1',
		)
		expect(toolMsg?.content).toContain('Tool not executed')

		const completedWithTools = events.filter(
			(e): e is Extract<RunEvent, { type: 'iteration_completed' }> =>
				e.type === 'iteration_completed',
		)
		expect(completedWithTools.some((e) => e.hasToolCalls === true)).toBe(true)
		expect(events.some((e) => e.type === 'tool_executing')).toBe(false)
	})

	it('warns and ends the turn when truncated with no tool calls', async () => {
		const provider = makeProvider(async () => lengthResponseNoTools('partial answer'))
		const { run } = await runQuery({ provider, messages: [createUserMessage('go')] })

		expect(provider.calls).toBe(1)
		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('end_turn')
	})
})

describe('iteration loop — context overflow recovery', () => {
	it('reduces history and reissues within the same iteration', async () => {
		const provider = makeProvider(async (_p, call) => {
			if (call === 0) throw new ProviderRequestError('overflow', { kind: 'context_overflow' })
			return stopResponse('recovered')
		})
		const seeded: Message[] = [
			createUserMessage('u1 with a long body of text to have something worth trimming'),
			createAssistantMessage('a1 with a long body of text to have something worth trimming'),
			createUserMessage('u2 with a long body of text to have something worth trimming'),
			createAssistantMessage('a2 with a long body of text to have something worth trimming'),
			createUserMessage('u3 with a long body of text to have something worth trimming'),
		]

		const { run } = await runQuery({ provider, messages: seeded })

		expect(provider.calls).toBe(2)
		expect(run.status).toBe('completed')
		// Oldest messages were trimmed by the reduction.
		expect(run.messages.some((m) => m.content?.includes('u1 with a long body'))).toBe(false)
	})

	it('fails without mutating history when overflow cannot be reduced', async () => {
		const provider = makeProvider(async () => {
			throw new ProviderRequestError('overflow', { kind: 'context_overflow' })
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('only one message in history')],
		})

		expect(provider.calls).toBe(1)
		expect(run.status).toBe('failed')
		expect(run.messages.some((m) => m.content?.includes('only one message'))).toBe(true)
	})
})

describe('iteration loop — deadline classification', () => {
	// The model call must outlive the run deadline: timeoutMs is comfortably above
	// the loop's setup cost (so the guard does not hard-stop before the call), and
	// the provider's delay crosses the deadline before it throws.
	const TIMEOUT_MS = 250
	const CROSS_DEADLINE_MS = 500

	it('an auth error fails with the original error, never reclassified as a timeout', async () => {
		// Misconfiguration must not be masked as a timeout. This is the end-to-end
		// half of the invariant — an auth error that arrives fails on its own terms,
		// and is not retried. The post-deadline half cannot be driven through a fake
		// provider at all (see the isDeadlineTimeoutStop block below), so this test
		// alone does NOT hold the gate up: it passes with the kind clause deleted.
		const provider = makeProvider(async () => {
			throw new ProviderRequestError('expired api key', { kind: 'auth', providerId: 'fake' })
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi')],
			runConfig: { timeoutMs: TIMEOUT_MS },
		})

		expect(provider.calls).toBe(1)
		expect(run.status).toBe('failed')
		expect(run.stopReason).not.toBe('timeout')
		expect(run.lastError).toContain('expired api key')
	})

	it('a post-deadline server error stops the run as a timeout', async () => {
		const provider = makeProvider(async (_p, call) => {
			if (call === 0) {
				await new Promise((r) => setTimeout(r, CROSS_DEADLINE_MS))
				throw new ProviderRequestError('overloaded', { kind: 'server', providerId: 'fake' })
			}
			// The subsequent requestFinalResponse call returns promptly.
			return stopResponse('final summary')
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi')],
			runConfig: { timeoutMs: TIMEOUT_MS },
		})

		expect(run.stopReason).toBe('timeout')
	})

	it('a provider that never answers cannot hold the run past timeoutMs', async () => {
		// The pre-freeze B2 guarantee, end to end. Before it, attemptModelCall checked
		// the deadline only BEFORE awaiting provider.chat, so a hang was unbounded: the
		// retry layer capped the number of attempts, not the duration of one.
		const provider = makeProvider(async (_p, call) => {
			// The requestFinalResponse call (its own grace budget) answers promptly.
			if (call > 0) return stopResponse('final summary')
			return new Promise<ChatCompletionResponse>(() => {})
		})

		const started = Date.now()
		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi')],
			runConfig: { timeoutMs: TIMEOUT_MS },
		})
		const elapsed = Date.now() - started

		expect(run.stopReason).toBe('timeout')
		// Generous ceiling — the point is that it terminates at all.
		expect(elapsed).toBeLessThan(10_000)
	})

	it('does not account the usage of a response that arrived after the deadline', async () => {
		// ses_015 pre-freeze R6 B1, end to end. The deadline was checked before the
		// request went out and never when its answer came back, and the timer is no
		// backstop for that: a provider that blocks SYNCHRONOUSLY past the deadline owns
		// the event loop for the whole overrun, so the overdue timer (a macrotask)
		// cannot run, while the reaction to the already-fulfilled promise it then
		// returns is a microtask and runs first. The loop accounted that response's
		// usage, pushed its message, and acted on it — on a budget that was already gone.
		const OVERDUE_TOKENS = 999_999
		const provider = makeProvider(async (_p, call) => {
			// The grace-budget final response after the timeout; answers promptly.
			if (call > 0) return stopResponse('final summary')

			const until = Date.now() + CROSS_DEADLINE_MS
			while (Date.now() < until) {
				// Synchronous block. Nothing else in the process runs, timers included.
			}
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'OVERDUE_CONTENT' },
				finishReason: 'stop',
				usage: {
					promptTokens: 1,
					completionTokens: OVERDUE_TOKENS - 1,
					totalTokens: OVERDUE_TOKENS,
				},
			} as ChatCompletionResponse
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi')],
			runConfig: { timeoutMs: TIMEOUT_MS },
		})

		// The bill is what discriminates. Without the arrival-time check the response is
		// simply accepted — and since it is a `stop`, the turn ENDS on it and the run
		// reports success, so a test that only asserted a clean termination would pass
		// against the defect. These three fail against it.
		expect(run.tokenUsage.totalTokens).toBeLessThan(OVERDUE_TOKENS)
		expect(run.messages.some((m) => m.content?.includes('OVERDUE_CONTENT'))).toBe(false)
		expect(run.stopReason).toBe('timeout')
	})

	it('a retryable error that exhausts its retries BEFORE the deadline fails the run', async () => {
		// The deadline half of the gate. A provider that is simply down must fail the
		// run: calling it a timeout would hide a dead provider behind a clock the run
		// never came close to spending. Retries are made instant so the deadline stays
		// far away throughout.
		const provider = makeProvider(async () => {
			throw new ProviderRequestError('overloaded', { kind: 'server', providerId: 'fake' })
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi')],
			runConfig: {
				timeoutMs: 600_000,
				retry: {
					enabled: true,
					maxAttempts: 2,
					baseDelayMs: 0,
					maxDelayMs: 0,
					overflowAttempts: 0,
				},
			},
		})

		expect(provider.calls).toBe(2)
		expect(run.status).toBe('failed')
		expect(run.stopReason).not.toBe('timeout')
		expect(run.lastError).toContain('overloaded')
	})
})

// ses_015 pre-freeze R3. The gate itself, in isolation.
//
// The end-to-end tests above cannot cover it. Since pre-freeze B2 the model call
// stops WAITING at the deadline, so an error a provider reports afterwards is
// never observed by the loop at all — there is no fake provider that can deliver a
// post-deadline auth error to the iteration catch, and the previous round's
// attempt to weaken the auth test into something that passed left the kind clause
// completely untested (deleting it kept all 1126 tests green).
//
// The clause is still load-bearing in production: errors raised OUTSIDE the model
// call's deadline race do reach the catch late — a context_overflow rethrown by
// callModelWithOverflowRecovery when the reducer cannot shrink, a store or tool
// exception, an auth error surfacing across a scheduling gap. Without the clause
// every one of them is reported as a timeout and the real cause is lost.
describe('isDeadlineTimeoutStop — both halves of the gate', () => {
	const DEADLINE = 1_000
	const AFTER = DEADLINE + 1
	const BEFORE = DEADLINE - 1

	it('classifies a post-deadline retryable transport error as a timeout', () => {
		for (const kind of ['throttle', 'server', 'network'] as const) {
			const err = new ProviderRequestError('transport', { kind, providerId: 'fake' })
			expect(isDeadlineTimeoutStop(err, DEADLINE, AFTER)).toBe(true)
		}
	})

	it('never classifies a post-deadline auth error as a timeout', () => {
		// Kills the mutant that drops the retryable-kind clause: an expired key must
		// fail the run as auth, so the operator sees the misconfiguration.
		const err = new ProviderRequestError('expired api key', { kind: 'auth', providerId: 'fake' })
		expect(isDeadlineTimeoutStop(err, DEADLINE, AFTER)).toBe(false)
	})

	it('never classifies a post-deadline non-retryable or non-provider error as a timeout', () => {
		for (const kind of ['bad_request', 'context_overflow', 'unknown'] as const) {
			const err = new ProviderRequestError('terminal', { kind, providerId: 'fake' })
			expect(isDeadlineTimeoutStop(err, DEADLINE, AFTER)).toBe(false)
		}
		expect(isDeadlineTimeoutStop(new Error('tool blew up'), DEADLINE, AFTER)).toBe(false)
	})

	it('does not classify a retryable error as a timeout while the deadline is still ahead', () => {
		// Kills the mutant that drops the deadline clause.
		const err = new ProviderRequestError('overloaded', { kind: 'server', providerId: 'fake' })
		expect(isDeadlineTimeoutStop(err, DEADLINE, BEFORE)).toBe(false)
	})
})
