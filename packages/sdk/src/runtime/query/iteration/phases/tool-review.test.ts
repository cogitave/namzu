/**
 * Current-code invariants asserted (2026-07-12, ses_017):
 *
 *   The gate is consulted on two planes and this file exercises both, because the
 *   harness wires both the way `runtime/query/index.ts` does. THIS phase's gate
 *   decides what a HUMAN is asked (deny before review; allow-vs-review for the
 *   rest). The executor's `denyFinalInput` decides what RUNS, against the input
 *   after every rewrite. A modification denied below is denied by this phase — the
 *   executor would catch it too, but the phase drops it from the approved set,
 *   which is what makes the outcome 'rejected' rather than a dispatched batch that
 *   comes back denied. See `__tests__/executor-deny-check.test.ts` for the
 *   backstop's own invariants.
 *
 *   - No gate configured: every call in the batch goes to the human, and
 *     `approve_tools` executes all of them.
 *   - Gate configured, every call allowed: no human is consulted; the batch runs.
 *   - Gate configured, every call denied: nothing runs, outcome is 'rejected', the
 *     model gets a `[SYSTEM]` summary message.
 *   - (ses_017 fix) A gate-DENIED call is removed from the batch BEFORE the human
 *     sees it. It never appears in the `tool_review_requested` event nor in the
 *     `ResumeHandler` request, and no human decision can restore it: `approve_tools`
 *     on a mixed batch executes the reviewable calls and NOT the denied one. It is
 *     answered immediately with a denial tool-result, so the assistant/tool pair
 *     stays provider-valid. Before the fix, a mixed batch was handed to the human
 *     whole and `approve_tools` ran `executeBatch(response)` — the original,
 *     unfiltered batch — so a human approval executed a call an explicit deny rule
 *     had refused.
 *   - (ses_017 fix) A `modify_tools` modification is RE-EVALUATED against the gate
 *     before it runs. A modification the gate denies is not executed and yields a
 *     denial tool-result. A gate evaluation that THROWS on the modified input is a
 *     deny (fail-closed; see conventions/fail-closed-gates), not an allow.
 *     Before the fix, verification ran on the ORIGINAL input only, so a benign
 *     approved call could be rewritten into a denied operation and executed.
 *   - A modification that stays within the rules still executes, with the modified
 *     input reaching the tool.
 *   - `modify_tools` with `action: 'deny'` drops the call and answers it with a
 *     denial tool-result; if nothing survives, outcome is 'rejected'.
 *   - `reject_tools` / `pause` / `abort` execute nothing. `pause` and `abort` return
 *     'stop' and set the stop reason ('paused' / cancelled + markCancelled).
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../../registry/tool/execute.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { ToolDefinition } from '../../../../types/tool/index.js'
import type { VerificationGateConfig } from '../../../../types/verification/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { VerificationGate } from '../../../../verification/gate.js'
import { ToolExecutor } from '../../executor.js'
import { type ToolReviewOutcome, runToolReview } from './tool-review.js'

const runId = 'run_test' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

interface Harness {
	ctx: Parameters<typeof runToolReview>[0]
	messages: Message[]
	events: RunEvent[]
	reviewed: HITLDecisionRequest[]
	execs: Record<string, ReturnType<typeof vi.fn>>
	stopReason: string | null
	cancelled: boolean
	log: Logger
}

/**
 * A real ToolExecutor over a real ToolRegistry — "did not execute" is asserted at
 * the tool's own execute fn, not at a mock of the seam under test.
 */
function makeHarness(opts: {
	gate?: VerificationGateConfig
	decision: HITLResumeDecision
}): Harness {
	const log = makeLogger()
	const registry = new ToolRegistry({ logger: log })

	const execs: Record<string, ReturnType<typeof vi.fn>> = {}
	for (const name of ['safe_tool', 'dangerous_tool', 'write_file', 'brittle_tool']) {
		const execute = vi.fn(async () => ({ success: true, output: `${name} ran` }))
		execs[name] = execute
		registry.register({
			name,
			description: name,
			inputSchema: z.object({
				path: z.string().optional(),
				command: z.string().optional(),
				mode: z.string().optional(),
			}),
			execute,
			// The canonical throwing predicate from conventions/fail-closed-gates: a
			// one-liner that reaches into an input shape without checking it. It
			// answers for the original input and throws for an input with no `path`.
			...(name === 'brittle_tool'
				? { isReadOnly: (input: unknown) => (input as { path: string }).path.startsWith('/ro') }
				: {}),
		} as unknown as ToolDefinition)
	}

	const messages: Message[] = []
	const events: RunEvent[] = []
	const reviewed: HITLDecisionRequest[] = []

	// One object, mutated in place by the stubs below — a spread copy would freeze
	// `stopReason` at its initial value and quietly pass every assertion about it.
	const harness = {
		messages,
		events,
		reviewed,
		execs,
		stopReason: null,
		cancelled: false,
		log,
	} as Harness

	const emitEvent = async (event: RunEvent): Promise<void> => {
		events.push(event)
	}

	// One gate, both planes — as `runtime/query/index.ts` wires it. The review phase
	// gets the gate itself (it needs allow-vs-review); the executor gets it as a bare
	// deny decision over the FINAL input. Wiring only one of them here would let a
	// green test describe a topology that does not ship.
	const gate = opts.gate ? new VerificationGate(opts.gate, log) : undefined

	const toolExecutor = new ToolExecutor(
		{
			tools: registry,
			runId,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			denyCheck: gate ? (call) => gate.evaluate(call) : undefined,
		},
		new ActivityStore(runId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		emitEvent,
		log,
	)

	harness.ctx = {
		tools: registry,
		toolExecutor,
		log,
		emitEvent,
		drainPending: function* (): Generator<RunEvent> {},
		runMgr: {
			id: runId,
			pushMessage: (m: Message) => messages.push(m),
			setStopReason: (r: string) => {
				harness.stopReason = r
			},
			markCancelled: () => {
				harness.cancelled = true
			},
		},
		checkpointMgr: {
			create: async () => ({ id: 'cp_test' }),
		},
		// The review checkpoint records the run's accumulated active execution time,
		// which only the guard meters (ses_017). This phase reads it; it does not
		// interpret it, so a constant is enough here.
		guard: { activeElapsedMs: 0 },
		resumeHandler: async (request: HITLDecisionRequest): Promise<HITLResumeDecision> => {
			reviewed.push(request)
			return opts.decision
		},
		verificationGate: gate,
	} as unknown as Parameters<typeof runToolReview>[0]

	return harness
}

function buildResponse(calls: Array<{ id: string; name: string; args: unknown }>) {
	return {
		id: 'resp_1',
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: calls.map((c) => ({
				id: c.id,
				type: 'function',
				function: { name: c.name, arguments: JSON.stringify(c.args) },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

async function drive(h: Harness, response: ChatCompletionResponse): Promise<ToolReviewOutcome> {
	const gen = runToolReview(h.ctx, response, 1)
	let step = await gen.next()
	while (!step.done) {
		step = await gen.next()
	}
	return step.value
}

/** Every tool-call id the human was actually asked about, across all requests. */
function reviewedIds(h: Harness): string[] {
	return h.reviewed.flatMap((r) => (r.type === 'tool_review' ? r.toolCalls.map((tc) => tc.id) : []))
}

function toolResultFor(h: Harness, toolCallId: string): Message | undefined {
	return h.messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId)
}

const DENY_BY_NAME: VerificationGateConfig = {
	enabled: true,
	rules: [{ type: 'deny_by_name', toolNames: ['dangerous_tool'] }],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: true,
}

describe('runToolReview — no gate', () => {
	it('sends the whole batch to the human and executes it on approve_tools', async () => {
		const h = makeHarness({ decision: { action: 'approve_tools' } })

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('executed')
		expect(reviewedIds(h)).toEqual(['call_1'])
		expect(h.execs.safe_tool).toHaveBeenCalledOnce()
	})
})

describe('runToolReview — verification gate', () => {
	it('does NOT execute a gate-denied call when the human approves the batch', async () => {
		const h = makeHarness({ gate: DENY_BY_NAME, decision: { action: 'approve_tools' } })

		const outcome = await drive(
			h,
			buildResponse([
				{ id: 'call_deny', name: 'dangerous_tool', args: { command: 'wipe' } },
				{ id: 'call_review', name: 'safe_tool', args: { path: '/tmp/a' } },
			]),
		)

		// The reviewable half ran; the denied half did not, despite a blanket approval.
		expect(outcome).toBe('executed')
		expect(h.execs.safe_tool).toHaveBeenCalledOnce()
		expect(h.execs.dangerous_tool).not.toHaveBeenCalled()

		// The human never saw it — it cannot be approved because it was never offered.
		expect(reviewedIds(h)).toEqual(['call_review'])
		const requested = h.events.find((e) => e.type === 'tool_review_requested')
		expect(requested).toBeDefined()
		expect(
			(requested as Extract<RunEvent, { type: 'tool_review_requested' }>).toolCalls.map(
				(tc) => tc.id,
			),
		).toEqual(['call_review'])

		// It is answered immediately, so the assistant/tool pair stays provider-valid.
		const denial = toolResultFor(h, 'call_deny')
		expect(denial?.content).toContain('blocked by verification gate')
	})

	it('executes an all-allowed batch without consulting the human', async () => {
		const h = makeHarness({
			gate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['safe_tool'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: true,
			},
			decision: { action: 'reject_tools', feedback: 'should never be asked' },
		})

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('executed')
		expect(h.reviewed).toHaveLength(0)
		expect(h.execs.safe_tool).toHaveBeenCalledOnce()
	})

	it('rejects an all-denied batch without consulting the human', async () => {
		const h = makeHarness({ gate: DENY_BY_NAME, decision: { action: 'approve_tools' } })

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_deny', name: 'dangerous_tool', args: { command: 'wipe' } }]),
		)

		expect(outcome).toBe('rejected')
		expect(h.reviewed).toHaveLength(0)
		expect(h.execs.dangerous_tool).not.toHaveBeenCalled()
		expect(toolResultFor(h, 'call_deny')?.content).toContain('blocked by verification gate')
		expect(h.messages.some((m) => m.role === 'user' && m.content?.includes('[SYSTEM]'))).toBe(true)
	})
})

describe('runToolReview — modify_tools re-enters the gate', () => {
	const DENY_PASSWD: VerificationGateConfig = {
		enabled: true,
		rules: [
			{ type: 'custom_pattern', pattern: '/etc/(passwd|shadow)', target: 'args', decision: 'deny' },
		],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: true,
	}

	it('does NOT execute a modification that the gate denies', async () => {
		const h = makeHarness({
			gate: DENY_PASSWD,
			decision: {
				action: 'modify_tools',
				modifications: [
					{ toolCallId: 'call_1', action: 'modify', modifiedInput: { path: '/etc/passwd' } },
				],
			},
		})

		// The ORIGINAL input is benign, so the gate sends it to review and the human
		// "approves" it — by rewriting it into a call the deny rule matches.
		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'write_file', args: { path: '/tmp/ok' } }]),
		)

		expect(h.execs.write_file).not.toHaveBeenCalled()
		expect(outcome).toBe('rejected')
		expect(toolResultFor(h, 'call_1')?.content).toContain('blocked by verification gate')
		expect(h.log.warn).toHaveBeenCalledWith(
			expect.stringContaining('modified tool call denied'),
			expect.objectContaining({ tool: 'write_file' }),
		)
	})

	it('denies a modification whose gate evaluation THROWS on a serializable input (fail-closed)', async () => {
		// `brittle_tool.isReadOnly` reads `input.path.startsWith(...)`. The original
		// call has a `path`, so the gate answers (review → human). The modification
		// drops it, so the SAME predicate throws — on an input that is otherwise
		// perfectly executable. Fail-open here does not crash, it RUNS the tool;
		// that is what makes this the discriminating case.
		const h = makeHarness({
			gate: {
				enabled: true,
				rules: [],
				allowReadOnlyTools: true,
				denyDangerousPatterns: false,
				logDecisions: true,
			},
			decision: {
				action: 'modify_tools',
				modifications: [
					{ toolCallId: 'call_1', action: 'modify', modifiedInput: { mode: 'evil' } },
				],
			},
		})

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'brittle_tool', args: { path: '/tmp/ok' } }]),
		)

		expect(h.execs.brittle_tool).not.toHaveBeenCalled()
		expect(outcome).toBe('rejected')
		expect(toolResultFor(h, 'call_1')?.content).toContain('blocked by verification gate')
		expect(h.log.error).toHaveBeenCalledWith(
			expect.stringContaining('Verification gate threw'),
			expect.objectContaining({ tool: 'brittle_tool' }),
		)
	})

	it('denies a modification the gate cannot even serialize (fail-closed)', async () => {
		// A modify payload that cannot be serialized: `deny_dangerous_patterns`
		// stringifies the input, so evaluating THIS input throws where evaluating the
		// original (which came off the wire as JSON) could not. A gate that cannot
		// answer must not be read as an approval.
		const circular: Record<string, unknown> = { path: '/tmp/ok' }
		circular.self = circular

		const h = makeHarness({
			gate: {
				enabled: true,
				rules: [],
				allowReadOnlyTools: false,
				denyDangerousPatterns: true,
				logDecisions: true,
			},
			decision: {
				action: 'modify_tools',
				modifications: [{ toolCallId: 'call_1', action: 'modify', modifiedInput: circular }],
			},
		})

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'write_file', args: { path: '/tmp/ok' } }]),
		)

		expect(h.execs.write_file).not.toHaveBeenCalled()
		expect(outcome).toBe('rejected')
		expect(toolResultFor(h, 'call_1')?.content).toContain('blocked by verification gate')
		expect(h.log.error).toHaveBeenCalledWith(
			expect.stringContaining('Verification gate threw'),
			expect.objectContaining({ tool: 'write_file' }),
		)
	})

	it('executes a modification that stays within the rules, with the modified input', async () => {
		const h = makeHarness({
			gate: DENY_PASSWD,
			decision: {
				action: 'modify_tools',
				modifications: [
					{ toolCallId: 'call_1', action: 'modify', modifiedInput: { path: '/tmp/safer' } },
				],
			},
		})

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'write_file', args: { path: '/tmp/ok' } }]),
		)

		expect(outcome).toBe('executed')
		expect(h.execs.write_file).toHaveBeenCalledWith(
			{ path: '/tmp/safer' },
			expect.objectContaining({ runId }),
		)
	})

	it('cannot modify a gate-denied call back into the batch', async () => {
		const h = makeHarness({
			gate: DENY_BY_NAME,
			decision: {
				action: 'modify_tools',
				modifications: [
					// The client names the denied call's id anyway. It is not in the
					// reviewable set, so there is nothing for this to attach to.
					{ toolCallId: 'call_deny', action: 'approve' },
					{ toolCallId: 'call_review', action: 'approve' },
				],
			},
		})

		const outcome = await drive(
			h,
			buildResponse([
				{ id: 'call_deny', name: 'dangerous_tool', args: { command: 'wipe' } },
				{ id: 'call_review', name: 'safe_tool', args: { path: '/tmp/a' } },
			]),
		)

		expect(outcome).toBe('executed')
		expect(h.execs.dangerous_tool).not.toHaveBeenCalled()
		expect(h.execs.safe_tool).toHaveBeenCalledOnce()
	})

	it('drops a user-denied call and rejects when nothing survives', async () => {
		const h = makeHarness({
			decision: {
				action: 'modify_tools',
				modifications: [{ toolCallId: 'call_1', action: 'deny' }],
			},
		})

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('rejected')
		expect(h.execs.safe_tool).not.toHaveBeenCalled()
		expect(toolResultFor(h, 'call_1')?.content).toContain('denied by user')
	})
})

describe('runToolReview — decisions that stop or reject (regression)', () => {
	it('reject_tools executes nothing and tells the model why', async () => {
		const h = makeHarness({ decision: { action: 'reject_tools', feedback: 'not now' } })

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('rejected')
		expect(h.execs.safe_tool).not.toHaveBeenCalled()
		expect(h.messages.at(-1)?.content).toBe('[SYSTEM] Tool calls rejected: not now')
		expect(h.events.some((e) => e.type === 'tool_review_completed')).toBe(true)
	})

	it('pause stops the run and executes nothing', async () => {
		const h = makeHarness({ decision: { action: 'pause', reason: 'stepping away' } })

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('stop')
		expect(h.execs.safe_tool).not.toHaveBeenCalled()
		expect(h.stopReason).toBe('paused')
		expect(h.events.some((e) => e.type === 'run_paused')).toBe(true)
	})

	it('abort cancels the run and executes nothing', async () => {
		const h = makeHarness({ decision: { action: 'abort', reason: 'no' } })

		const outcome = await drive(
			h,
			buildResponse([{ id: 'call_1', name: 'safe_tool', args: { path: '/tmp/a' } }]),
		)

		expect(outcome).toBe('stop')
		expect(h.execs.safe_tool).not.toHaveBeenCalled()
		expect(h.stopReason).toBe('cancelled')
		expect(h.cancelled).toBe(true)
	})
})
