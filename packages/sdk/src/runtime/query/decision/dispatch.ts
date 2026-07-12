import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import type {
	HITLDecisionRequest,
	IterationCheckpoint,
	PendingDecision,
	ToolCallSummary,
} from '../../../types/hitl/index.js'
import type { AssistantMessage } from '../../../types/message/index.js'
import { createToolMessage, createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { runAdvisoryPhase } from '../iteration/phases/advisory.js'
import { runIterationCheckpoint } from '../iteration/phases/checkpoint.js'
import type { IterationContext, PhaseSignal } from '../iteration/phases/context.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
import { type ProviderToolCall, type ReviewableCall, applyReviewOutcome } from './apply.js'
import {
	journalSettled,
	journalStarted,
	recoverFromJournal,
	uncertainToolResult,
} from './pending.js'

interface DispatchContext extends IterationContext {
	readonly verificationGate?: import('../../../verification/gate.js').VerificationGate
}

export interface DispatchOptions {
	/**
	 * True when this segment built a sandbox and the decision was parked in a PREVIOUS
	 * one — so the approved batch is about to run in a sandbox that has none of the state
	 * the earlier iterations built. See {@link FRESH_SANDBOX_NOTE}.
	 */
	readonly freshSandbox?: boolean
}

/**
 * What the model is told when the batch it is about to see ran in a sandbox that was
 * built after the pause.
 *
 * A `Sandbox` cannot outlive the process: `SandboxProvider.create()` mints a fresh root
 * and `destroy()` removes it, and there is no attach-by-id anywhere in the contract. So
 * a run that pauses for a human — which is a pause that is *meant* to outlive the
 * process — cannot keep it. Holding one open instead would strand a temp tree and its
 * processes for as long as a human takes to answer, which is worse, and would still not
 * survive the redeploy the durable pause exists to survive.
 *
 * What we CAN refuse to do is let it happen silently. A run that spent iterations
 * installing dependencies and writing files, then parked for review of
 * `bash ./deploy.sh`, comes back to an empty filesystem — and a model told only
 * "no such file: ./deploy.sh" concludes the deploy is broken and starts debugging a
 * phantom. Told the truth, it rebuilds what it needs. Appended AFTER the batch's tool
 * results, which is both where it is useful and the only provider-valid position: a
 * message between an assistant tool-call block and its results is a history no provider
 * accepts.
 */
const FRESH_SANDBOX_NOTE =
	'[SYSTEM] This run was paused and has resumed in a NEW, EMPTY sandbox. Files, installed packages, background processes and any other sandbox-local state created before the pause were NOT carried across the pause — a fresh sandbox is a fresh filesystem. Tool results above that report missing files or missing setup are describing that, not a failure of your earlier work. Re-create what you need before relying on it.'

/**
 * Locate the tool-call block the decision is about.
 *
 * The LAST assistant message carrying tool calls in the restored history — which, on a
 * checkpoint written by the review phase, is the final message, because the review runs
 * before any result is written.
 *
 * **The decision's ids are a SUBSET of the block's, not its equal**, and demanding
 * equality made a whole class of pause permanently unresumable. The verification gate
 * strips a denied call from the REQUEST (and answers it, there and then, with a denial
 * result) while leaving it in the assistant MESSAGE, where it has to stay — it is what
 * the model actually said. So a batch of `[danger, noop]` whose `danger` the gate denied
 * parks with a decision naming one call and a block carrying two. Under set-equality the
 * resume threw "names tool calls that are not the checkpoint's pending block", the run
 * ended `failed`, the tool the human explicitly approved never ran — and the token was
 * spent, so it could not be tried again.
 *
 * What the check must actually establish is that every call the decision names is in
 * this block: an id the block does NOT carry means the decision and the checkpoint
 * describe different runs, and executing on the strength of that approval would be
 * executing a batch nobody reviewed. The calls come back filtered to exactly the ones
 * the decision names, so a caller cannot reach a call the human was never shown — the
 * gate-denied one keeps the denial it already got.
 */
function findReviewedBlock(
	messages: readonly { role: string }[],
	request: Extract<HITLDecisionRequest, { type: 'tool_review' }>,
): { assistant: AssistantMessage; calls: ProviderToolCall[] } | null {
	const reviewedIds = new Set(request.toolCalls.map((tc) => tc.id))
	if (reviewedIds.size === 0) return null

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as AssistantMessage | undefined
		if (!msg || msg.role !== 'assistant') continue
		const calls = msg.toolCalls
		if (!calls || calls.length === 0) continue

		const blockIds = new Set(calls.map((c) => c.id))
		if (![...reviewedIds].every((id) => blockIds.has(id))) return null

		return { assistant: msg, calls: calls.filter((c) => reviewedIds.has(c.id)) }
	}
	return null
}

function toReviewable(
	calls: readonly ProviderToolCall[],
	summaries: readonly ToolCallSummary[],
): ReviewableCall[] {
	const byId = new Map(summaries.map((s) => [s.id, s]))
	return calls.map((call) => {
		const summary = byId.get(call.id) ?? {
			id: call.id,
			name: call.function.name,
			input: call.function.arguments,
			isDestructive: false,
		}
		return { call, summary, decision: 'review' as const }
	})
}

/**
 * Rebuild the model response the interrupted iteration was working on.
 *
 * **Usage is zero, and that is not a shortcut.** The model call this response came from
 * happened in the previous segment and its tokens are already in the ledger the
 * checkpoint restored. Re-accumulating them here would bill the run a second time for
 * one call — every resume, forever — which is the same class of accounting bug P1 just
 * closed from the other direction.
 */
function reconstructResponse(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
	assistant: AssistantMessage,
): ChatCompletionResponse {
	return {
		id: `resumed_${checkpoint.id}`,
		model: ctx.runConfig.model,
		message: {
			role: 'assistant',
			content: assistant.content,
			toolCalls: assistant.toolCalls,
		},
		finishReason: 'tool_calls',
		usage: { ...EMPTY_TOKEN_USAGE },
	} as ChatCompletionResponse
}

/**
 * The model response of the iteration a non-tool_review decision interrupted.
 *
 * The advisory phase reads one thing off it — the category of the last tool called — so
 * it is rebuilt from the assistant message the restored history already carries rather
 * than being invented. A history with no tool-call block yields a response with no
 * calls, which is what the advisor is then told, honestly. Usage is zero for the same
 * reason it is zero in {@link reconstructResponse}: those tokens are already in the
 * ledger the checkpoint restored.
 */
function reconstructResponseFromHistory(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
): ChatCompletionResponse {
	const messages = ctx.runMgr.messages
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as AssistantMessage | undefined
		if (msg?.role !== 'assistant') continue
		if (!msg.toolCalls || msg.toolCalls.length === 0) continue
		return reconstructResponse(ctx, checkpoint, msg)
	}
	return reconstructResponse(ctx, checkpoint, {
		role: 'assistant',
		content: null,
	} as AssistantMessage)
}

/**
 * Re-emit a decision that is still unanswered, and park the run again.
 *
 * The SAME `requestId` — a durable pause that minted a fresh id on every resume would
 * make an idempotent client answer the same question twice, and would leave two live
 * tokens for one decision. Re-emitting is idempotent by construction: nothing about the
 * persisted decision changes.
 */
async function* reparkPending(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
	decision: PendingDecision,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const request = decision.request

	if (request.type === 'tool_review') {
		await ctx.emitEvent({
			type: 'tool_review_requested',
			runId: ctx.runMgr.id,
			requestId: decision.requestId,
			checkpointId: checkpoint.id,
			toolCalls: request.toolCalls,
			iteration: checkpoint.iteration,
		})
	}

	await ctx.runMgr.markSuspended({
		checkpointId: checkpoint.id,
		requestId: decision.requestId,
	})
	await ctx.emitEvent({
		type: 'run_paused',
		runId: ctx.runMgr.id,
		checkpointId: checkpoint.id,
		reason: 'Awaiting a decision that has not arrived yet',
	})
	yield* ctx.drainPending()

	ctx.log.info('Resumed onto a still-pending decision — re-emitted and parked again', {
		runId: ctx.runMgr.id,
		requestId: decision.requestId,
		checkpointId: checkpoint.id,
	})
	return 'suspend'
}

/**
 * Finish the iteration the pause interrupted.
 *
 * A resumed run must NOT start a fresh iteration: the interrupted one had already run
 * its model call, its review and (now) its tools, and everything downstream of the
 * tool batch — the post-tool checkpoint, the advisory phase, the `iteration_end` hooks,
 * the `iteration_completed` event — belongs to IT. Starting iteration N+1 instead would
 * silently skip all of them, so a plugin that reconciles state on `iteration_end` would
 * never see the iteration whose tools actually ran, and the advisor would never see the
 * batch it exists to advise on.
 *
 * This is the tail of `IterationOrchestrator.runLoop`, replayed at the point the pause
 * cut it off. It deliberately does not emit `iteration_started` — that already happened,
 * in the segment before the pause.
 *
 * **`fromCheckpointPhase` says how much of the tail is left**, and it is not a
 * convenience flag. The two decisions that park mid-iteration park at different points:
 * a `tool_review` parks BEFORE the post-tool checkpoint (so that checkpoint is still
 * owed), while an `iteration_checkpoint` parks INSIDE it (so re-running it would write a
 * second checkpoint and re-ask the very question that parked the run — a resume that
 * immediately parks again, forever). Resuming an `iteration_checkpoint` used to skip the
 * tail entirely instead: it flipped the decision to `settled`, returned 'continue', and
 * let the loop start iteration N+1 — losing the advisory phase, the `iteration_end`
 * hooks and the `iteration_completed` event of the iteration whose tools had actually
 * run. That is the same bug this function exists to close, arriving through the other
 * door.
 */
async function* completeInterruptedTail(
	ctx: DispatchContext,
	iterationNum: number,
	response: ChatCompletionResponse,
	fromCheckpointPhase = false,
): AsyncGenerator<RunEvent, PhaseSignal> {
	if (!fromCheckpointPhase) {
		const checkpointSignal = yield* runIterationCheckpoint(ctx, iterationNum)
		if (checkpointSignal !== 'continue') return checkpointSignal
	}

	await runAdvisoryPhase(ctx, iterationNum, response)

	if (ctx.pluginManager) {
		const hookResults = await ctx.pluginManager.executeHooks(
			'iteration_end',
			{ runId: ctx.runMgr.id, iteration: iterationNum },
			ctx.emitEvent,
		)
		applyLifecycleHookResults('iteration_end', hookResults)
		yield* ctx.drainPending()
	}

	await ctx.emitEvent({
		type: 'iteration_completed',
		runId: ctx.runMgr.id,
		iteration: iterationNum,
		hasToolCalls: true,
	})
	yield* ctx.drainPending()

	return 'continue'
}

/**
 * Apply a redeemed outcome to the exact tool-call block it was raised for, then finish
 * the interrupted iteration.
 */
async function* applyResolved(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
	decision: PendingDecision,
	request: Extract<HITLDecisionRequest, { type: 'tool_review' }>,
	options: DispatchOptions,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const outcome = decision.outcome
	if (!outcome) {
		throw new Error(
			`Decision ${decision.requestId} is 'resolved' with no recorded outcome — the record is corrupt`,
		)
	}

	if (outcome.action === 'abort') {
		await ctx.emitEvent({
			type: 'tool_review_completed',
			runId: ctx.runMgr.id,
			decision: 'rejected',
		})
		yield* ctx.drainPending()
		await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({
			...d,
			state: 'cancelled',
		}))
		ctx.runMgr.setStopReason('cancelled')
		ctx.runMgr.markCancelled()
		return 'stop'
	}

	const block = findReviewedBlock(ctx.runMgr.messages, request)
	if (!block) {
		throw new Error(
			`Decision ${decision.requestId} names tool calls that are not the checkpoint's pending block — refusing to execute a batch nobody reviewed`,
		)
	}

	const reviewable = toReviewable(block.calls, request.toolCalls)
	const applied = applyReviewOutcome({
		reviewable,
		outcome,
		gate: ctx.verificationGate,
		tools: ctx.tools,
		log: ctx.log,
	})

	await ctx.emitEvent({
		type: 'tool_review_completed',
		runId: ctx.runMgr.id,
		decision:
			outcome.action === 'reject_tools'
				? 'rejected'
				: outcome.action === 'modify_tools'
					? 'modified'
					: 'approved',
	})
	yield* ctx.drainPending()

	// **The right to dispatch is claimed, not assumed.** Redemption hands exactly one
	// caller a PreparedDecisionResume; it does not stop that caller from being RUN twice —
	// a retried request, a queue that delivered the job twice, an operator re-driving a
	// resume that looked stuck. Two drives would both read `resolved` here and both
	// dispatch the batch, which is the double-execution the single-use token exists to
	// prevent, reached one layer down. Losing this claim means somebody else is already
	// executing (or already has), so this run refuses rather than charging the card twice.
	// It fails the run, loudly: two concurrent resumes of one decision is a caller bug,
	// and the safe reading of a bug is to stop.
	//
	// The honest cost, stated rather than hidden: a process that dies between winning this
	// claim and writing the journal below leaves a claim nobody is acting on, and the next
	// resume refuses a batch that in fact never ran. Recovering that needs an operator (the
	// claim file names the decision). It is the deliberate trade — the alternative reading,
	// "the claim is stale, go ahead", is indistinguishable from "the winner is 5ms from
	// dispatching", and being wrong about that runs a destructive batch twice. A resume
	// that stops and asks is recoverable; a second charge on a customer's card is not.
	if (applied.approved.length > 0) {
		const won = await ctx.checkpointMgr.claimExecution(checkpoint.id, decision)
		if (!won) {
			throw new Error(
				`Decision ${decision.requestId} is already being executed by another resume of run ${ctx.runMgr.id} — refusing to dispatch its tool batch a second time`,
			)
		}
	}

	// The journal opens BEFORE anything is dispatched. If the process dies between this
	// write and the batch coming back, `executing` plus these entries is what tells the
	// next resume that these calls may already have run — which is the only alternative
	// to re-running them and hoping.
	await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({
		...d,
		state: 'executing',
		journal: journalStarted(applied.approved),
	}))

	if (applied.approved.length > 0) {
		const batch = await ctx.toolExecutor.executeBatch(
			{
				...reconstructResponse(ctx, checkpoint, block.assistant),
				message: { ...block.assistant, toolCalls: applied.approved },
			} as ChatCompletionResponse,
			{
				onCallSettled: async (settled) => {
					await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({
						...d,
						journal: journalSettled(d.journal, settled),
					}))
				},
			},
		)
		for (const msg of batch.messages) {
			ctx.runMgr.pushMessage(msg)
		}
	}

	for (const denial of applied.denials) {
		ctx.runMgr.pushMessage(createToolMessage(denial.output, denial.toolCallId))
	}
	if (applied.systemNote) {
		ctx.runMgr.pushMessage(createUserMessage(applied.systemNote))
	}
	if (options.freshSandbox && applied.approved.length > 0) {
		ctx.runMgr.pushMessage(createUserMessage(FRESH_SANDBOX_NOTE))
	}

	await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({ ...d, state: 'settled' }))

	// Nothing ran and the model has been told why. Same shape as the live path's
	// 'rejected' outcome: skip the tail, let the loop take another turn.
	if (applied.approved.length === 0) return 'continue'

	return yield* completeInterruptedTail(
		ctx,
		checkpoint.iteration,
		reconstructResponse(ctx, checkpoint, block.assistant),
	)
}

/**
 * Recover from a crash that happened while the batch was in flight.
 *
 * **Nothing is re-executed here. Ever.** The executor fans out with `Promise.all` and
 * records results only after the whole batch settles, so a crash mid-batch leaves calls
 * whose real-world effect is genuinely unknown — and re-running them because a human
 * took an hour is precisely the failure mode that charges a customer twice.
 *
 *   - A call the journal recorded as `settled` keeps its recorded output. It ran once,
 *     we have the result, we use it.
 *   - Everything else is uncertain: it MAY have run and had its full effect. It is
 *     answered with a result that says so, surfaced on the event stream, and recorded
 *     on the decision. It is not retried and it is not guessed at.
 *
 * That is honest at-least-once. Exactly-once for arbitrary side effects is a fiction —
 * every durable-execution engine reviewed for this design says so and makes idempotency
 * the tool author's job — and the useful thing a framework can do is refuse to pretend
 * otherwise.
 */
async function* recoverExecuting(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
	decision: PendingDecision,
	request: Extract<HITLDecisionRequest, { type: 'tool_review' }>,
	options: DispatchOptions,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const block = findReviewedBlock(ctx.runMgr.messages, request)
	if (!block) {
		throw new Error(
			`Decision ${decision.requestId} crashed mid-execution and its tool-call block is not in the restored history — cannot recover`,
		)
	}

	// Only the calls that were actually dispatched are in the journal; a call denied at
	// review never entered it, and must still be answered so the block stays valid.
	const dispatched = new Set((decision.journal ?? []).map((e) => e.toolCallId))
	const { settled, uncertain } = recoverFromJournal(
		block.calls.filter((c) => dispatched.has(c.id)),
		decision.journal,
	)

	for (const call of block.calls) {
		if (!dispatched.has(call.id)) {
			ctx.runMgr.pushMessage(
				createToolMessage(
					`Error: Tool call "${call.function.name}" was not executed — it was denied at review.`,
					call.id,
				),
			)
			continue
		}

		const entry = settled.get(call.id)
		if (entry?.output !== undefined) {
			ctx.runMgr.pushMessage(createToolMessage(entry.output, call.id))
			continue
		}

		const toolName = call.function.name
		ctx.runMgr.pushMessage(createToolMessage(uncertainToolResult(toolName), call.id))
		await ctx.emitEvent({
			type: 'tool_execution_uncertain',
			runId: ctx.runMgr.id,
			toolCallId: call.id,
			toolName,
		})
		ctx.log.warn('Tool call may have already run — NOT re-executing', {
			runId: ctx.runMgr.id,
			tool: toolName,
			toolCallId: call.id,
			requestId: decision.requestId,
		})
	}
	if (options.freshSandbox) {
		ctx.runMgr.pushMessage(createUserMessage(FRESH_SANDBOX_NOTE))
	}
	yield* ctx.drainPending()

	await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({
		...d,
		state: 'settled',
		uncertainToolCallIds: uncertain,
	}))

	ctx.log.info('Recovered a batch that crashed mid-execution', {
		runId: ctx.runMgr.id,
		settled: settled.size,
		uncertain: uncertain.length,
	})

	return yield* completeInterruptedTail(
		ctx,
		checkpoint.iteration,
		reconstructResponse(ctx, checkpoint, block.assistant),
	)
}

/**
 * The resume dispatcher.
 *
 * **Where it sits is the design.** It runs in `query()`, OUTSIDE `runLoop`, after the
 * checkpoint is restored and the run's accounting is hydrated and the deps and sandbox
 * are built — and BEFORE compaction and before any model call. That ordering is not a
 * preference; it is the fix. Everything that used to happen to a resumed history first
 * destroys it:
 *
 *   - `prepareResumeMessages` REPAIRS it, rewriting the pending tool call into a
 *     "tool result missing" placeholder. (Now suppressed while a decision owns the
 *     block — see {@link import('./pending.js').decisionOwnsToolBlock}.)
 *   - `runCompactionCheck`, at the top of every iteration, may summarise or drop it.
 *   - the model call then ships whatever survived.
 *
 * The dispatcher runs before all three, so the decision is applied to the block while
 * the block still exists. There is no path from a restored pending decision to a
 * provider that does not pass through here.
 */
export async function* dispatchPendingDecision(
	ctx: DispatchContext,
	checkpoint: IterationCheckpoint,
	options: DispatchOptions = {},
): AsyncGenerator<RunEvent, PhaseSignal> {
	const decision = checkpoint.pendingDecision
	if (!decision) return 'continue'

	ctx.log.info('Dispatching a persisted decision before the loop starts', {
		runId: ctx.runMgr.id,
		requestId: decision.requestId,
		state: decision.state,
		type: decision.request.type,
	})

	// `settled` and `cancelled` no longer own anything. The history was repaired on the
	// way in (the predicate says so), the tools' real results live in a later checkpoint,
	// and resuming from this far back is a fork whose tools genuinely did not run. There
	// is nothing to apply.
	if (decision.state === 'settled' || decision.state === 'cancelled') {
		return 'continue'
	}

	if (decision.state === 'pending') {
		return yield* reparkPending(ctx, checkpoint, decision)
	}

	const request = decision.request
	if (request.type !== 'tool_review') {
		// A parked iteration_checkpoint has no tool-call block to protect — its tools ran
		// before it was raised — so there is nothing to APPLY. What it does still owe is
		// the rest of the iteration it interrupted: the checkpoint phase sits ahead of the
		// advisory phase, the `iteration_end` hooks and the `iteration_completed` event, so
		// a pause there cuts the iteration off after its tools and before every consumer
		// that is entitled to hear how it ended. Settling and returning 'continue' — which
		// is what this did — restarted the loop at iteration N+1 and skipped all of them
		// permanently: a plugin reconciling on `iteration_end` silently loses the iteration
		// whose tools actually ran, and a client pairing started/completed waits forever.
		//
		// (A plan_approval never parks durably — the checkpoint cannot restore PlanManager,
		// so parking one would strand the run; the plan gate ends the run instead.)
		const outcome = decision.outcome
		await ctx.checkpointMgr.updatePendingDecision(checkpoint.id, (d) => ({
			...d,
			state: 'settled',
		}))
		if (outcome?.action === 'abort') {
			ctx.runMgr.setStopReason('cancelled')
			ctx.runMgr.markCancelled()
			return 'stop'
		}
		if (request.type !== 'iteration_checkpoint') return 'continue'

		return yield* completeInterruptedTail(
			ctx,
			checkpoint.iteration,
			reconstructResponseFromHistory(ctx, checkpoint),
			// The checkpoint phase is where this decision was raised. Running it again would
			// write a second checkpoint and re-ask the question that parked the run.
			true,
		)
	}

	if (decision.state === 'executing') {
		return yield* recoverExecuting(ctx, checkpoint, decision, request, options)
	}

	return yield* applyResolved(ctx, checkpoint, decision, request, options)
}
