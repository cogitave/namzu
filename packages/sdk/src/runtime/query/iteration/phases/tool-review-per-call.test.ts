import { describe, expect, it, vi } from 'vitest'

import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { ToolManager } from '../../../../toolsets/manager.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	PerCallReviewConfig,
	ResumeContext,
	ToolCallSummary,
} from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import { ToolGrantSet } from '../../tool-grants.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

const SESSION_ID = generateSessionId()
const TURN_ID = '91977d69-9b92-46f6-baa5-d077027fed93' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/** Lets every pending microtask and I/O callback run; waits for no clock. */
const settleWork = () => new Promise<void>((resolve) => setImmediate(resolve))

/** `read` and `grep` are safe to run side by side; `bash` and `edit` are not. */
const SAFE = new Set(['read', 'grep'])

function call(id: string, name: string, input: Record<string, unknown> = {}) {
	return {
		id,
		type: 'function' as const,
		function: { name, arguments: JSON.stringify({ ...input, id }) },
	}
}

function responseOf(...calls: ReturnType<typeof call>[]): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test',
		message: { role: 'assistant', content: null, toolCalls: calls },
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

interface OpenQuestion {
	readonly request: Extract<HITLDecisionRequest, { type: 'tool_review' }>
	readonly context: ResumeContext | undefined
	answer(decision: HITLResumeDecision): void
}

interface Harness {
	readonly ctx: IterationContext
	readonly messages: Message[]
	readonly questions: OpenQuestion[]
	readonly started: string[]
	readonly finished: string[]
	readonly signals: Map<string, AbortSignal>
	readonly audits: Array<{
		outcome: string
		reason?: string
		what: { tool?: string }
	}>
	readonly events: Array<{ type: string; decision?: string }>
	readonly setStopReason: ReturnType<typeof vi.fn>
	readonly markCancelled: ReturnType<typeof vi.fn>
	/** Resolves the named tool's run; the tool waits for this or for its abort. */
	finish(id: string): void
	/** Resolves once `count` questions have been put to the handler. */
	untilQuestions(count: number): Promise<void>
	/** Resolves once the call has started running. */
	untilStarted(id: string): Promise<void>
	abortTurn(): void
}

function harness(
	options: {
		perCallReview?: PerCallReviewConfig | undefined
		batchHandler?: (request: HITLDecisionRequest) => HITLResumeDecision
		escalations?: Record<string, ToolCallSummary['escalation']>
		toolGrants?: ToolGrantSet
		reviewAllowed?: () => boolean
	} = {},
): Harness {
	const messages: Message[] = []
	const questions: OpenQuestion[] = []
	const started: string[] = []
	const finished: string[] = []
	const signals = new Map<string, AbortSignal>()
	const audits: Harness['audits'] = []
	const events: Harness['events'] = []
	const log = makeLogger()
	const runs = new Map<string, ReturnType<typeof deferred>>()
	const waiters: Array<{ count: number; resolve: () => void }> = []
	const startWaiters: Array<{ id: string; resolve: () => void }> = []
	const turn = new AbortController()

	const runFor = (id: string) => {
		let run = runs.get(id)
		if (!run) {
			run = deferred()
			runs.set(id, run)
		}
		return run
	}

	const tools = {
		get: vi.fn((name: string) => ({
			name,
			category: 'filesystem',
			isReadOnly: () => SAFE.has(name),
			isDestructive: () => !SAFE.has(name),
			isConcurrencySafe: () => SAFE.has(name),
		})),
		execute: vi.fn(
			async (name: string, input: { id: string }, context: { abortSignal: AbortSignal }) => {
				started.push(input.id)
				signals.set(input.id, context.abortSignal)
				for (const waiter of startWaiters.filter((w) => w.id === input.id)) waiter.resolve()
				const cancelled = new Promise<'cancelled'>((resolve) => {
					context.abortSignal.addEventListener('abort', () => resolve('cancelled'), { once: true })
				})
				const outcome = await Promise.race([runFor(input.id).promise.then(() => 'done'), cancelled])
				finished.push(input.id)
				return outcome === 'cancelled'
					? { success: false, output: '', error: `${name} was cancelled` }
					: { success: true, output: `${name} ok` }
			},
		),
		has: vi.fn(() => true),
		sourceOf: vi.fn(() => ({ id: 'host', kind: 'host_tool' as const })),
		listNames: vi.fn(() => ['read', 'grep', 'bash', 'edit']),
		availability: vi.fn(() => 'active'),
	} as unknown as ToolManager

	const toolExecutor = new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: turn.signal,
		},
		new ActivityStore(TURN_ID, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		}),
		async () => {},
		log,
	)
	if (options.escalations) {
		// The escalation checks themselves are the executor's own and tested there;
		// here a call is simply declared to reach past the turn's boundary.
		vi.spyOn(
			toolExecutor as unknown as {
				escalationOf: (call: { toolCall: { id: string } }) => Promise<unknown>
			},
			'escalationOf',
		).mockImplementation(async (prepared) => options.escalations?.[prepared.toolCall.id])
	}

	let checkpoints = 0
	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: turn,
		parkRecordDelayMs: 60_000,
		recorder: {
			id: TURN_ID,
			turnId: TURN_ID,
			sessionId: SESSION_ID,
			messages,
			pushMessage: (m: Message) => {
				messages.push(m)
			},
			setStopReason: undefined as unknown,
			markCancelled: undefined as unknown,
			recordAudit: async (audit: Harness['audits'][number]) => {
				audits.push(audit)
				return undefined as never
			},
		},
		checkpointMgr: {
			create: async () => ({ id: `cp_${++checkpoints}` }),
			park: async () => undefined,
			unpark: async () => null,
		},
		emitEvent: async (event: { type: string; decision?: string }) => {
			events.push(event)
		},
		drainPending: async function* () {},
		resumeHandler: (request: HITLDecisionRequest, context?: ResumeContext) => {
			if (options.batchHandler) return Promise.resolve(options.batchHandler(request))
			return new Promise<HITLResumeDecision>((resolve) => {
				questions.push({
					request: request as OpenQuestion['request'],
					context,
					answer: resolve,
				})
				for (const waiter of waiters.filter((w) => questions.length >= w.count)) waiter.resolve()
			})
		},
		...(options.perCallReview ? { perCallReview: options.perCallReview } : {}),
		...(options.toolGrants ? { toolGrants: options.toolGrants } : {}),
		...(options.reviewAllowed ? { reviewAllowedCalls: options.reviewAllowed } : {}),
	} as unknown as IterationContext
	const setStopReason = vi.fn()
	const markCancelled = vi.fn()
	;(ctx.recorder as unknown as Record<string, unknown>).setStopReason = setStopReason
	;(ctx.recorder as unknown as Record<string, unknown>).markCancelled = markCancelled

	return {
		ctx,
		messages,
		questions,
		started,
		finished,
		signals,
		audits,
		events,
		setStopReason,
		markCancelled,
		finish: (id) => runFor(id).resolve(undefined),
		untilQuestions: (count) =>
			questions.length >= count
				? Promise.resolve()
				: new Promise<void>((resolve) => waiters.push({ count, resolve })),
		untilStarted: (id) =>
			started.includes(id)
				? Promise.resolve()
				: new Promise<void>((resolve) => startWaiters.push({ id, resolve })),
		abortTurn: () => turn.abort(new Error('stopped by the test')),
	}
}

async function drive(ctx: IterationContext, resp: ChatCompletionResponse) {
	const gen = runToolReview(ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value
}

const approve: HITLResumeDecision = { action: 'approve_tools' }

function expectEveryCallAnswered(messages: Message[], resp: ChatCompletionResponse) {
	const history: Message[] = [
		{
			role: 'assistant',
			content: resp.message.content,
			toolCalls: resp.message.toolCalls,
		} as Message,
		...messages,
	]
	expect(findDanglingMessages(history).isValid).toBe(true)
	const answered = messages
		.filter((m): m is Message & { toolCallId: string } => m.role === 'tool')
		.map((m) => m.toolCallId)
	expect(answered.sort()).toEqual((resp.message.toolCalls ?? []).map((tc) => tc.id).sort())
}

const toolText = (messages: Message[], id: string) =>
	String(messages.find((m) => m.role === 'tool' && m.toolCallId === id)?.content)

describe('per-call review: execute while asking', () => {
	it('opens the one-call questions of safe calls together and holds an unsafe call until they finish', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'), call('b1', 'bash'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		expect(h.questions.map((q) => q.request.toolCalls.map((c) => c.id))).toEqual([['r1'], ['r2']])
		expect(h.questions.every((q) => q.request.perCall === true)).toBe(true)
		// The unsafe call is not asked while an earlier call is still open.
		await settleWork()
		expect(h.questions).toHaveLength(2)

		// An approved call starts right after its grant, before the sibling's answer.
		h.questions[0]?.answer(approve)
		await h.untilStarted('r1')
		expect(h.started).toEqual(['r1'])
		h.questions[1]?.answer(approve)
		await h.untilStarted('r2')
		await settleWork()
		expect(h.questions).toHaveLength(2)

		h.finish('r1')
		await settleWork()
		// One earlier call is still running: the unsafe call keeps waiting.
		expect(h.questions).toHaveLength(2)
		h.finish('r2')
		await h.untilQuestions(3)
		expect(h.questions[2]?.request.toolCalls.map((c) => c.id)).toEqual(['b1'])
		expect(h.started).not.toContain('b1')
		h.questions[2]?.answer(approve)
		await h.untilStarted('b1')
		h.finish('b1')

		const outcome = await running
		expect(outcome.decision).toBe('executed')
		expect(h.started).toEqual(['r1', 'r2', 'b1'])
		expectEveryCallAnswered(h.messages, resp)
	})

	it('does not start a safe call that follows an unsafe call that is still waiting', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(call('b1', 'bash'), call('r1', 'read'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(1)
		expect(h.questions[0]?.request.toolCalls[0]?.id).toBe('b1')
		await settleWork()
		expect(h.questions).toHaveLength(1)

		h.questions[0]?.answer(approve)
		await h.untilStarted('b1')
		await settleWork()
		// The unsafe call is running: the read that came after it still waits.
		expect(h.questions).toHaveLength(1)
		h.finish('b1')
		await h.untilQuestions(2)
		h.questions[1]?.answer(approve)
		await h.untilStarted('r1')
		h.finish('r1')
		await running
		expect(h.started).toEqual(['b1', 'r1'])
	})

	it('a refusal with a reason refuses only that call and the others carry on', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		h.questions[0]?.answer({
			action: 'reject_tools',
			feedback: 'Use the other file.',
			declined: { note: 'Use the other file.' },
		})
		h.questions[1]?.answer(approve)
		await h.untilStarted('r2')
		h.finish('r2')

		const outcome = await running
		expect(outcome.decision).toBe('executed')
		expect(h.started).toEqual(['r2'])
		expect(toolText(h.messages, 'r1')).toContain('Use the other file.')
		expect(h.setStopReason).not.toHaveBeenCalled()
		expectEveryCallAnswered(h.messages, resp)
		// The person's words are on the record as theirs, apart from any gate denial.
		expect(h.audits).toContainEqual(
			expect.objectContaining({
				outcome: 'refused',
				reason: 'declined by the person: Use the other file.',
			}),
		)
	})

	it('a plain refusal cancels what runs, refuses what has not started, closes open questions and ends the turn', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(
			call('r1', 'read'),
			call('r2', 'grep'),
			call('r3', 'read'),
			call('b1', 'bash'),
		)
		const running = drive(h.ctx, resp)

		await h.untilQuestions(3)
		h.questions[0]?.answer(approve)
		await h.untilStarted('r1')
		const toolSignal = h.signals.get('r1') as AbortSignal
		expect(toolSignal.aborted).toBe(false)

		h.questions[1]?.answer({
			action: 'reject_tools',
			feedback: 'declined',
			declined: {},
			endTurn: true,
		})
		const outcome = await running

		expect(outcome.decision).toBe('stop')
		expect(toolSignal.aborted).toBe(true)
		// The question left open on the third call was closed from here.
		expect(h.questions[2]?.context?.signal?.aborted).toBe(true)
		// The unsafe call was never asked.
		expect(h.questions).toHaveLength(3)
		expect(h.started).toEqual(['r1'])
		expect(h.setStopReason).toHaveBeenCalledWith('cancelled')
		expect(h.markCancelled).toHaveBeenCalledTimes(1)
		expectEveryCallAnswered(h.messages, resp)
		expect(toolText(h.messages, 'b1')).toContain('turn was stopped')
		expect(toolText(h.messages, 'r3')).toContain('turn was stopped')
	})

	it('treats an answer that does not name the call as a refusal, never an approval', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'), call('r3', 'read'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(3)
		h.questions[0]?.answer({
			action: 'modify_tools',
			modifications: [{ toolCallId: 'someone-else', action: 'approve' }],
		})
		h.questions[1]?.answer({ action: 'approve_plan' })
		h.questions[2]?.answer({
			action: 'modify_tools',
			modifications: [{ toolCallId: 'r3', action: 'modify', modifiedInput: { path: 'x' } }],
		})
		const outcome = await running

		expect(outcome.decision).toBe('rejected')
		expect(h.started).toEqual([])
		expectEveryCallAnswered(h.messages, resp)
	})

	it('closes every open question and settles the batch when the turn is cancelled', async () => {
		const h = harness({ perCallReview: {} })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		h.abortTurn()
		const outcome = await running

		expect(outcome.decision).toBe('stop')
		expect(h.questions.every((q) => q.context?.signal?.aborted === true)).toBe(true)
		expect(h.started).toEqual([])
		expectEveryCallAnswered(h.messages, resp)
	})

	it('a refusal that carries endTurn also stops a batch reviewed as a unit, after answering every call', async () => {
		const h = harness({
			batchHandler: () => ({
				action: 'reject_tools',
				feedback: 'no',
				declined: {},
				endTurn: true,
			}),
		})
		const resp = responseOf(call('r1', 'read'), call('b1', 'bash'))
		const outcome = await drive(h.ctx, resp)

		expect(outcome.decision).toBe('stop')
		expect(h.started).toEqual([])
		expect(h.setStopReason).toHaveBeenCalledWith('cancelled')
		expectEveryCallAnswered(h.messages, resp)
	})
})

describe('per-call review: the batch path does not change', () => {
	it('without the option the handler sees one request for the whole batch and no per-call field', async () => {
		const requests: HITLDecisionRequest[] = []
		const h = harness({
			batchHandler: (request) => {
				requests.push(request)
				return approve
			},
		})
		const resp = responseOf(call('r1', 'read'), call('b1', 'bash'))
		const running = drive(h.ctx, resp)
		await h.untilStarted('r1')
		h.finish('r1')
		await h.untilStarted('b1')
		h.finish('b1')
		const outcome = await running

		expect(outcome.decision).toBe('executed')
		expect(requests).toHaveLength(1)
		const request = requests[0] as Extract<HITLDecisionRequest, { type: 'tool_review' }>
		expect(request.toolCalls.map((c) => c.id)).toEqual(['r1', 'b1'])
		expect('perCall' in request).toBe(false)
		expect(h.events.filter((e) => e.type === 'tool_review_requested')).toHaveLength(1)
	})
})

describe('per-call review: re-checks while questions are open', () => {
	function withRules() {
		const listeners = new Set<() => void>()
		const covered = new Set<string>()
		const config: PerCallReviewConfig = {
			onRulesChanged: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			covers: (summary) => covered.has(summary.id),
		}
		return {
			config,
			cover: (id: string) => covered.add(id),
			changed: () => {
				for (const listener of listeners) listener()
			},
			listeners,
		}
	}

	it('lets a covered open question through unasked and records that nobody was shown it', async () => {
		const rules = withRules()
		const h = harness({ perCallReview: rules.config })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		rules.cover('r2')
		rules.changed()
		await h.untilStarted('r2')
		// The question about the covered call was closed for the host to take down.
		expect(h.questions[1]?.context?.signal?.aborted).toBe(true)
		expect(h.questions[0]?.context?.signal?.aborted).toBe(false)
		expect(h.audits).toContainEqual(
			expect.objectContaining({
				outcome: 'approved',
				what: { action: 'tool_call', tool: 'grep' },
				reason: expect.stringContaining('without being shown'),
			}),
		)

		h.questions[0]?.answer(approve)
		await h.untilStarted('r1')
		h.finish('r1')
		h.finish('r2')
		const outcome = await running
		expect(outcome.decision).toBe('executed')
		expect(rules.listeners.size).toBe(0)
	})

	it('never approves a call that reaches past the boundary or that a rule asked a person about', async () => {
		const rules = withRules()
		const h = harness({
			perCallReview: rules.config,
			escalations: { r2: { outsidePaths: ['/etc'] } },
		})
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		rules.cover('r1')
		rules.cover('r2')
		rules.changed()
		await h.untilStarted('r1')
		await settleWork()
		// r1 was covered; r2 reaches outside the roots and stays a question.
		expect(h.questions[1]?.context?.signal?.aborted).toBe(false)
		expect(h.started).toEqual(['r1'])

		h.questions[1]?.answer(approve)
		await h.untilStarted('r2')
		h.finish('r1')
		h.finish('r2')
		await running
	})

	it('a re-check that covers nothing leaves every question open and refuses nothing', async () => {
		const rules = withRules()
		const h = harness({ perCallReview: rules.config })
		const resp = responseOf(call('r1', 'read'), call('r2', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		rules.changed()
		await settleWork()
		expect(h.questions.every((q) => q.context?.signal?.aborted === false)).toBe(true)
		expect(h.started).toEqual([])

		h.questions[0]?.answer(approve)
		h.questions[1]?.answer(approve)
		await h.untilStarted('r2')
		h.finish('r1')
		h.finish('r2')
		await running
		expect(h.started.sort()).toEqual(['r1', 'r2'])
	})

	it('an approval that remembers a grant covers an open question for the same tool', async () => {
		const grants = new ToolGrantSet()
		const h = harness({ perCallReview: {}, toolGrants: grants })
		const resp = responseOf(call('r1', 'read'), call('r2', 'read'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		h.questions[0]?.answer({ action: 'approve_tools', remember: ['read'] })
		await h.untilStarted('r2')
		expect(h.questions[1]?.context?.signal?.aborted).toBe(true)
		h.finish('r1')
		h.finish('r2')
		const outcome = await running
		expect(outcome.decision).toBe('executed')
		expect(h.started.sort()).toEqual(['r1', 'r2'])
	})

	it('a mode stricter than the rules keeps a rule-covered question open', async () => {
		const grants = new ToolGrantSet()
		const h = harness({
			perCallReview: {},
			toolGrants: grants,
			reviewAllowed: () => true,
		})
		const resp = responseOf(call('r1', 'read'), call('r2', 'read'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(2)
		h.questions[0]?.answer({ action: 'approve_tools', remember: ['read'] })
		await h.untilStarted('r1')
		await settleWork()
		expect(h.questions[1]?.context?.signal?.aborted).toBe(false)
		h.questions[1]?.answer(approve)
		await h.untilStarted('r2')
		h.finish('r1')
		h.finish('r2')
		await running
	})
})

describe('per-call review: questions about the whole batch come first', () => {
	it('asks the named calls together before anything starts and refuses them all on a No', async () => {
		const config: PerCallReviewConfig = { askTogether: () => ['r1', 'r2'] }
		const h = harness({ perCallReview: config })
		const resp = responseOf(call('r1', 'read'), call('r2', 'read'), call('r3', 'grep'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(1)
		expect(h.questions[0]?.request.toolCalls.map((c) => c.id)).toEqual(['r1', 'r2'])
		expect(h.started).toEqual([])
		h.questions[0]?.answer({
			action: 'reject_tools',
			feedback: 'no screen',
			declined: {},
		})
		await h.untilQuestions(2)
		expect(h.questions[1]?.request.toolCalls.map((c) => c.id)).toEqual(['r3'])
		h.questions[1]?.answer(approve)
		await h.untilStarted('r3')
		h.finish('r3')
		const outcome = await running

		expect(outcome.decision).toBe('executed')
		expect(h.started).toEqual(['r3'])
		expect(toolText(h.messages, 'r1')).toContain('no screen')
		expect(toolText(h.messages, 'r2')).toContain('no screen')
		expectEveryCallAnswered(h.messages, resp)
	})

	it('a Yes to the group approves those calls without a second question each', async () => {
		const config: PerCallReviewConfig = { askTogether: () => ['r1', 'r2'] }
		const h = harness({ perCallReview: config })
		const resp = responseOf(call('r1', 'read'), call('r2', 'read'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(1)
		h.questions[0]?.answer(approve)
		await h.untilStarted('r2')
		h.finish('r1')
		h.finish('r2')
		await running
		expect(h.questions).toHaveLength(1)
		expect(h.started.sort()).toEqual(['r1', 'r2'])
	})
})

describe('per-call review: escalations are confirmed per call', () => {
	it('a yes that does not confirm a sandbox escape refuses that call only', async () => {
		const h = harness({
			perCallReview: {},
			escalations: { b1: { sandboxEscape: true } },
		})
		const resp = responseOf(call('r1', 'read'), call('b1', 'bash'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(1)
		h.questions[0]?.answer(approve)
		await h.untilStarted('r1')
		h.finish('r1')
		await h.untilQuestions(2)
		h.questions[1]?.answer(approve)
		const outcome = await running

		expect(h.started).toEqual(['r1'])
		expect(outcome.decision).toBe('executed')
		expect(toolText(h.messages, 'b1')).toContain('outside the sandbox')
		expectEveryCallAnswered(h.messages, resp)
	})

	it('a yes that names the escape runs the call', async () => {
		const h = harness({
			perCallReview: {},
			escalations: { b1: { sandboxEscape: true } },
		})
		const resp = responseOf(call('b1', 'bash'))
		const running = drive(h.ctx, resp)

		await h.untilQuestions(1)
		h.questions[0]?.answer({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
		await h.untilStarted('b1')
		h.finish('b1')
		await running
		expect(h.started).toEqual(['b1'])
	})
})
