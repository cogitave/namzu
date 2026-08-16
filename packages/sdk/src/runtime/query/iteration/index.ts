import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { resolveContextWindow } from '../../../compaction/context-window.js'
import { extractFromAssistantMessage } from '../../../compaction/extractor.js'
import { AUTO_CONTINUATION_USER_MESSAGE } from '../../../constants/continuation.js'
import {
	DEFAULT_STRUCTURED_OUTPUT_RETRIES,
	STRUCTURED_OUTPUT_REPROMPT,
} from '../../../constants/tools/index.js'
import { formatCompletionNotification } from '../../../gateway/completion-inbox.js'
import { renderSkillsSection } from '../../../persona/assembler.js'
import { collect } from '../../../provider/collect.js'
import {
	GENAI,
	NAMZU,
	agentIterationSpanName,
	parentContext,
} from '../../../telemetry/attributes.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/builtins/structuredOutput.js'
import { DELEGATION_TIMEOUT_MS } from '../../../tools/coordinator/index.js'
import type { CostInfo, TokenUsage } from '../../../types/common/index.js'
import type { MessageId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ToolChoice } from '../../../types/provider/chat.js'
import { classifyProviderError } from '../../../types/provider/errors.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { AnswerReview } from '../../../types/run/answer-review.js'
import type {
	PrepareStepResult,
	RunEvent,
	StepFailure,
	StepProvenance,
	StepResult,
	StepVeto,
	StopReason,
} from '../../../types/run/index.js'
import type { Skill } from '../../../types/skills/index.js'
import type { LLMToolSchema, ToolRegistryContract } from '../../../types/tool/index.js'
import { toErrorMessage } from '../../../utils/error.js'
import { stableDigest } from '../../../utils/hash.js'
import { generateMessageId } from '../../../utils/id.js'
import type { ToolCallOutcome } from '../executor.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'
import { runAdvisoryPhase } from './phases/advisory.js'
import { runIterationCheckpoint } from './phases/checkpoint.js'
import { measureContext, relieveOverflow, runCompactionCheck } from './phases/compaction.js'
import type { IterationContext } from './phases/index.js'
import { runPlanGate } from './phases/plan.js'
import { runToolReview } from './phases/tool-review.js'
import { refreshWorkingMemory } from './phases/working-memory.js'
import { streamProviderTurn } from './stream-turn.js'

export type { IterationContext } from './phases/index.js'
export type { PhaseSignal } from './phases/index.js'
export type { ToolReviewOutcome } from './phases/index.js'

/**
 * How many times an answer may be handed back before the run stops.
 *
 * Bounded for the same reason the structured-output re-prompt is: a judge
 * that never accepts would otherwise spend the whole token budget
 * rediscovering that, and the run would end on a budget error rather than
 * on the thing that actually went wrong.
 */
const DEFAULT_ANSWER_REVIEW_LIMIT = 3

/**
 * The share of a run's REMAINING time a settle-hold may take.
 *
 * The rule is borrowed from `AGENT_MANAGER_DEFAULTS.maxBudgetFraction`, which
 * gives a spawned child at most half of what its parent has left: one
 * sub-activity may take a share of the remainder, never the remainder. The
 * value is written out here rather than imported, because that field is a
 * host-tunable knob about TOKEN allocation and coupling the two would let a
 * host lowering one silently change the other.
 *
 * Half, specifically, because the hold is not the last thing the run does.
 * Its whole purpose is to put a worker's result where the model can read it,
 * and reading it costs a turn. A hold that spent everything remaining would
 * deliver a notification into a run with no turn left to act on it — the same
 * "the result exists and the model is never told" failure this mechanism was
 * built to close, wearing a different costume.
 */
const SETTLE_GRACE_FRACTION = 0.5

/**
 * How long a finishing run waits for a background worker it launched.
 *
 * Derived from the run rather than fixed, because a constant is wrong in both
 * directions at once. The 120 seconds this replaces held a run configured for
 * a twenty-second timeout open for 120,267 ms — six times its own budget, and
 * unreachable by the guard, which only checks between iterations — while on an
 * hour-long run it abandoned workers measured at 4m21s, 5m58s and 8m04s, all
 * of them well inside the hour the delegation tools themselves declare.
 *
 * **Bounded by construction, and against the right boundary.** The input is
 * time-to-FINALIZE, not time-to-deadline (see
 * `GuardCoordinator.remainingBeforeFinalizeMs`). Measuring to the deadline was
 * the first attempt and it was wrong in a way that looked safe: a hold cannot
 * outlive the deadline either way, but half of the time-to-deadline started
 * just under the warning threshold ends at 95% of the budget — so the slice
 * that exists for the run to produce a closing answer is half spent waiting
 * for the result that answer was supposed to use. Against the finalize point
 * the hold cannot reach the reserve at all, which is what makes the guard's
 * inability to interrupt a hold a non-issue rather than a smaller issue.
 *
 * **The floor of zero is a decision, not a clamp artefact.** A run with no
 * time left before it must start finishing has no turn in which to read a
 * notification, so waiting could only delay a stop that is already due.
 * Nothing is lost by it: `CompletionInbox.waitForArrival` returns before it
 * looks at its timer when a completion is already in hand, so a zero grace
 * still delivers everything that has arrived. No minimum is invented on top,
 * because zero is exactly what a run past the threshold should wait — and
 * reading the remainder at hold time rather than trusting `forceFinalize`,
 * which is sampled at the top of the iteration, is what makes a long iteration
 * that crossed the line in between compute it.
 *
 * **The ceiling is the longest anything in this subsystem waits for a
 * delegated worker.** It binds only for a host whose run timeout exceeds
 * roughly two and a quarter hours; below that the fraction is smaller.
 */
export function settleGraceMs(remainingBeforeFinalizeMs: number): number {
	return Math.min(
		Math.floor(remainingBeforeFinalizeMs * SETTLE_GRACE_FRACTION),
		DELEGATION_TIMEOUT_MS,
	)
}

export class IterationOrchestrator {
	private ctx: IterationContext
	/** Rejections so far. See {@link DEFAULT_ANSWER_REVIEW_LIMIT}. */
	private answerReviewAttempts = 0
	/**
	 * The last request envelope this run recorded, so an unchanged one
	 * costs a hash and no event. Per RUNNER, not module-level: two runs in
	 * one process must not suppress each other's first envelope.
	 */
	private lastEnvelopeKey: string | undefined
	/**
	 * The previous iteration held a `stopWhen` decision open for a worker.
	 *
	 * Set when the stop predicate fired and the run took one extra turn to
	 * read a delegated result, so the turn that then ends the run can report
	 * WHY it is over. Without it the outcome was right and the record was
	 * wrong: the run stopped because the host said so and reported `end_turn`,
	 * and this repo carries thirteen `StopReason` values precisely so that a
	 * run which ends for a nameable reason names it.
	 *
	 * Lives for exactly one iteration — see the read-and-clear at the top of
	 * the loop, which is the only site that touches it besides the one that
	 * sets it.
	 */
	private stopDeferredForOutstandingWork = false

	constructor(ctx: IterationContext) {
		this.ctx = ctx
	}

	/**
	 * Adopt the run's span after construction.
	 *
	 * The orchestrator is built before `query()` enters its generator body,
	 * which is where the run span is created — so the parent cannot be a
	 * constructor argument without reordering setup around one field.
	 */
	setRootSpan(span: Span): void {
		this.ctx = { ...this.ctx, rootSpan: span }
	}

	async *runLoop(): AsyncGenerator<RunEvent> {
		const { runConfig, runMgr } = this.ctx
		const { model } = runConfig
		const tracer = getTracer()

		// One context-overflow relief per *stuck point*, not per run.
		//
		// The latch exists so that a second overflow immediately after a
		// successful compaction — meaning the prompt is irreducible — stops
		// instead of looping. It was never meant to disarm the mechanism for
		// the rest of the run, which is what a run-scoped flag did: one
		// relief at iteration 3 left iteration 40 to die on an overflow with
		// obvious moves left. It is cleared by a turn that actually
		// succeeded, which is the evidence that the run is no longer stuck.
		let overflowRelieved = false

		const planSignal = yield* runPlanGate(this.ctx)
		if (planSignal === 'stop') return

		// A `finally` rather than a line at each exit, for the reason written
		// beside `iterSpan.end()` below: this loop leaves by eight `break`s,
		// two `return`s and a `throw`, and a rule every future edit has to
		// remember is a rule that gets forgotten — measured, it had been. Only
		// the ordinary final-answer exit consulted the inbox, so a run that
		// ended on a terminal tool, a structured output or the host's
		// `stopWhen` settled over a finished worker's output and threw it away.
		// A `finally` also covers a generator abandoned by its consumer, which
		// no post-loop block reaches.
		try {
			while (true) {
				// Read AND clear, in that order, in this one place.
				//
				// The flag is set by the previous iteration and read by this
				// one, so a clear that ran before the read would wipe it
				// before anything could use it — the obvious spelling of
				// "clear it at the top" is the broken one. Taking the value
				// into a local first gives the flag a lifetime of exactly one
				// iteration, which is the property that makes this cheap: no
				// path has to remember to clear it, because the next iteration
				// does so whether or not anything read it, and there is no
				// path by which a stale deferral can reach a later turn.
				const stopWasDeferredForOutstandingWork = this.stopDeferredForOutstandingWork
				this.stopDeferredForOutstandingWork = false

				const guardResult = this.ctx.guard.beforeIteration(runMgr, this.ctx.abortController.signal)

				if (guardResult.shouldStop) {
					if (guardResult.isCancelled) {
						this.ctx.log.info('Run cancelled by signal', { runId: runMgr.id })
						runMgr.setStopReason('cancelled')
						runMgr.markCancelled()
						break
					}

					const stopReason = guardResult.stopReason ?? 'end_turn'
					this.ctx.log.info('Guard enforcing stop', {
						runId: runMgr.id,
						stopReason,
						iteration: runMgr.currentIteration,
						inputTokens: runMgr.tokenUsage.promptTokens,
						outputTokens: runMgr.tokenUsage.completionTokens,
					})
					await this.requestFinalResponse(model, stopReason)
					yield* this.ctx.drainPending()
					runMgr.setStopReason(stopReason)
					break
				}

				// Consulted here, after the guard and BEFORE the iteration is
				// counted or the provider is called. `stopWhen` reads `steps`
				// and so can only speak after the step it disliked has already
				// run and been paid for; this is the seam a host with a live
				// rate limit or a revoked tenant actually needs.
				const veto = await this.beforeStep(runMgr.currentIteration + 1)
				if (veto) {
					// Namespaced. The un-namespaced keys elsewhere in this file are
					// the frozen inventory LOG-22 exists to drain; a new call site
					// has no reason to join it.
					this.ctx.log.info('Step refused by beforeStep', {
						'namzu.run.id': runMgr.id,
						'namzu.iteration': runMgr.currentIteration + 1,
						'namzu.step.veto_reason': veto.reason,
					})
					runMgr.setLastError(`beforeStep refused the next step: ${veto.reason}`)
					runMgr.setStopReason('step_refused')
					break
				}

				const forceFinalize = guardResult.forceFinalize
				const iterationNum = runMgr.incrementIteration()
				this.ctx.log.debug('Iteration started', {
					runId: runMgr.id,
					iteration: iterationNum,
					model,
					forceFinalize,
					messageCount: runMgr.messages.length,
				})

				const iterationActivity = this.ctx.activityStore.create({
					type: 'llm_turn',
					description: `LLM iteration ${iterationNum}`,
				})
				if (iterationActivity) {
					this.ctx.activityStore.start(iterationActivity.id)
				}

				// Parent explicitly: this body is an async generator, so the
				// ambient context at resume time belongs to the CONSUMER, not to
				// whoever created the run span. Without this every iteration
				// emits as its own root and a 20-turn run shows up as 21
				// disconnected traces.
				const iterSpan = tracer.startSpan(
					agentIterationSpanName(iterationNum),
					{},
					parentContext(this.ctx.rootSpan),
				)

				// Everything the step record needs, hoisted so the `catch` can
				// read whatever the iteration got as far as computing.
				//
				// The failure path is the one the ledger's own argument was
				// written for and the one it never reached: an iteration that
				// threw recorded a span exception and re-threw, so the turn with
				// no record was exactly the turn that went wrong. A reader could
				// not tell that from a turn that never happened.
				//
				// Declared as `let` with real initial values rather than left
				// undefined, because a failure BEFORE the snapshot below is
				// taken has spent nothing, and these are then exact. The success
				// path is untouched: the assignments inside the try still happen
				// where they always did, so compaction and the working-memory
				// refresh stay outside a successful step's window.
				let stepStartedAt = Date.now()
				let usageBefore: TokenUsage = { ...runMgr.tokenUsage }
				let costBefore: CostInfo = { ...runMgr.costInfo }
				let stepModel = model
				let stepMessageId: MessageId | undefined
				let stepResponse: ChatCompletionResponse | undefined
				let stepServedBy: StepProvenance | undefined

				try {
					// Tool spans for this turn belong under this iteration. Inside
					// the try rather than before it: a throw from any of these left
					// the span open, and an iteration span that never ends is a
					// trace that never closes — the export is incomplete for exactly
					// the run that failed.
					this.ctx.toolExecutor.setParentSpan(iterSpan)

					iterSpan.setAttributes({
						[NAMZU.ITERATION]: iterationNum,
						[NAMZU.RUN_ID]: runMgr.id,
						[GENAI.REQUEST_MODEL]: model,
					})

					await this.ctx.emitEvent({
						type: 'iteration_started',
						runId: runMgr.id,
						iteration: iterationNum,
					})
					yield* this.ctx.drainPending()

					if (this.ctx.pluginManager) {
						const hookResults = await this.ctx.pluginManager.executeHooks(
							'iteration_start',
							{ runId: runMgr.id, iteration: iterationNum },
							this.ctx.emitEvent,
						)
						applyLifecycleHookResults('iteration_start', hookResults)
						yield* this.ctx.drainPending()
					}

					// Re-pin the working-memory block from ground truth at the primacy
					// edge BEFORE compaction runs (so the refreshed slot is what
					// compaction preserves). No-op when no provider is configured.
					await refreshWorkingMemory(this.ctx)
					await runCompactionCheck(this.ctx)

					// Cache discipline: keep the tools param byte-stable even on the
					// forced-final iteration and forbid tool use via tool_choice
					// 'none' instead. Dropping the tools array would invalidate the
					// entire prompt-cache prefix (tools render at position 0) and
					// risks a 400 because the history still carries
					// tool_use/tool_result blocks.
					// Snapshot the cumulative counters so the step can report ITS
					// own usage rather than the run total.
					stepStartedAt = Date.now()
					usageBefore = { ...runMgr.tokenUsage }
					costBefore = { ...runMgr.costInfo }

					// Shape this step before calling the model. `stopWhen` decides
					// whether to keep going; this decides HOW. No-op when the host
					// supplied no hook.
					const step = await this.prepareStep(iterationNum)

					const stepAllowedTools = step.allowedTools ?? this.ctx.allowedTools
					const llmTools = this.ctx.tools.toLLMTools(stepAllowedTools)
					// The same list the request was built from now also bounds what
					// may run. Narrowing only the request left the restriction
					// presentational — the model was shown fewer tools and could
					// still call any of them by name.
					this.ctx.toolExecutor.setStepAllowedTools(stepAllowedTools)
					const enforceToolInputSchema = enforcedModelInputToolNames(this.ctx.tools, llmTools)
					stepModel = step.model ?? model

					const baseMessages = forceFinalize
						? [
								...runMgr.messages,
								createUserMessage(
									'[SYSTEM] You are approaching your resource limits. Provide your final, comprehensive response now based on everything you have gathered so far. Do not request any more tool calls.',
								),
							]
						: runMgr.messages

					// Step guidance is appended to the REQUEST, never pushed onto
					// the run's history: it applies to this step only, and pushing
					// it would accumulate one stale instruction per iteration.
					// Copy before it crosses the provider boundary. `runMgr.messages`
					// is the LIVE run array, and the loop pushes onto it after the
					// call returns — so a driver that retains what it was handed
					// (to log it, cache it, or replay it on retry) watched its own
					// input grow new turns underneath it. A capture provider in the
					// estate recorded every turn as identical to the last for
					// exactly this reason. Shallow is enough: the defect is array
					// mutation, and per-iteration this is trivial next to the model
					// call it precedes.
					// A step's skills and its guidance ride the same ephemeral
					// trailing system message. Appending leaves the cached prefix
					// intact; rewriting the run's own prompt to carry a phase's
					// skills would invalidate it on every iteration.
					// `renderSkillsSection` already answers null for an empty list, so
					// there is no length check here — a second guard for the same
					// case is one more thing to keep in agreement with the first.
					const stepSkills = step.skills ? renderSkillsSection([...step.skills]) : null
					const stepPreamble = [step.system, stepSkills].filter(Boolean).join('\n\n')
					const messages = stepPreamble
						? [...baseMessages, createSystemMessage(stepPreamble)]
						: [...baseMessages]

					// What the model is about to be ASKED, recorded when it
					// changed. `run_started` carries one system prompt and tool
					// schemas never reached the transcript at all — while
					// `prepareStep` rewrites the system text, narrows the tool
					// list or swaps the model, and a step's skills ride the
					// ephemeral preamble above. So a transcript showed one
					// question for a run that had asked several.
					//
					// Emitted only on a change: the digest is compared against
					// the last one this run recorded, so the common case costs
					// one hash and nothing else. Copying an unchanged system
					// prompt every iteration is the fastest way to make a
					// durable log too large to read.
					const envelope = {
						model: stepModel,
						// Read off `messages`, which is what the request is actually
						// built from — including the ephemeral preamble. Recomputing
						// it from the run's history would describe a request nobody
						// sent the moment the two diverge.
						systemPrompt: messages
							.filter((m) => m.role === 'system')
							.map((m) => String(m.content))
							.join('\n\n'),
						toolNames: llmTools.map((t) => t.function.name),
						// Over the SCHEMAS, sorted. A name list cannot see a tool
						// whose schema body changed while its name did not, which
						// is the change most likely to alter what the model does.
						toolSchemaDigest: stableDigest(
							[...llmTools].sort((a, b) => (a.function.name < b.function.name ? -1 : 1)),
						),
					}
					const envelopeKey = stableDigest(envelope)
					if (envelopeKey !== this.lastEnvelopeKey) {
						this.lastEnvelopeKey = envelopeKey
						await this.ctx.emitEvent?.({
							type: 'request_envelope',
							runId: runMgr.id,
							iteration: iterationNum,
							...envelope,
							toolNames: Object.freeze([...envelope.toolNames]),
						})
					}

					if (this.ctx.pluginManager) {
						const hookResults = await this.ctx.pluginManager.executeHooks(
							'pre_llm_call',
							{
								runId: runMgr.id,
								iteration: iterationNum,
								// Built inside the guard: a run with no plugins installed
								// pays nothing for a projection nobody reads.
								request: Object.freeze({
									model: stepModel,
									// Copied per turn, not handed over live: these are the
									// run's own message objects, and a hook writing into
									// one would edit the history the run is about to send.
									messages: Object.freeze(messages.map((m) => Object.freeze({ ...m }))),
									toolNames: Object.freeze(llmTools.map((t) => t.function.name)),
									temperature: step.temperature ?? runConfig.temperature,
									maxTokens: step.maxResponseTokens ?? runConfig.maxResponseTokens,
								}),
							},
							this.ctx.emitEvent,
						)
						applyLifecycleHookResults('pre_llm_call', hookResults)
						yield* this.ctx.drainPending()
					}

					// Phase 4 (ses_001-tool-stream-events): consume the
					// streaming response natively, emitting message and
					// tool-input lifecycle events as deltas arrive. The
					// helper yields RunEvents through drainPending() so SSE
					// consumers see live progress; its return value is the
					// aggregated `ChatCompletionResponse` for the legacy
					// downstream paths (assistantMsg construction, working
					// state extraction, telemetry attribute stamping).
					//
					// The message id is minted HERE, immediately before the call
					// that announces it,
					// rather than inside that call. The return value never arrives
					// when the stream throws, so a step recorded from the catch
					// could otherwise never name the message — and a stream that
					// died part-way has already emitted both `message_started` and
					// `message_completed` under this id, which is the trail a
					// reader wants most on exactly that turn.
					stepMessageId = generateMessageId()
					const { response, messageId } = yield* streamProviderTurn(
						this.ctx.provider,
						{
							model: stepModel,
							messages,
							tools: llmTools.length > 0 ? llmTools : undefined,
							...(enforceToolInputSchema ? { enforceToolInputSchema } : {}),
							// The forced-final turn wins: a step that asked to force a
							// tool cannot override the loop's own decision to stop
							// asking for them. Otherwise the step's choice applies —
							// and only to this step, because the next one is prepared
							// from scratch.
							toolChoice:
								forceFinalize && llmTools.length > 0
									? 'none'
									: llmTools.length > 0
										? step.toolChoice
										: undefined,
							temperature: step.temperature ?? runConfig.temperature,
							maxTokens: step.maxResponseTokens ?? runConfig.maxResponseTokens,
							cacheControl: { type: 'auto' },
							...(runConfig.thinking ? { thinking: runConfig.thinking } : {}),
							...(runConfig.effort ? { effort: runConfig.effort } : {}),
							// Thread the run abort into the model call so a Stop tears the
							// in-flight turn down (provider passes it to fetch; the consumer
							// also races it). Inert when never aborted.
							signal: this.ctx.abortController.signal,
						},
						this.ctx.emitEvent,
						this.ctx.drainPending,
						runMgr.id,
						iterationNum,
						forceFinalize,
						this.ctx.log,
						iterSpan,
						stepMessageId,
					)
					stepResponse = response

					// Who answered THIS turn.
					//
					// The read is exact at this point and stays exact: a chain that
					// has produced output cannot fall over again inside the same
					// request, so the member at the cursor when the stream ends is
					// the one whose bytes are in `response`.
					//
					// It is taken here rather than at `recordStep` several hundred
					// lines below, and the honest account of that is defence in
					// depth, not a defect it currently prevents. Moving it down
					// fails no test, because nothing between the two asks this
					// provider for anything: compaction and working memory run
					// BEFORE the turn, the advisory phase runs after the step is
					// already recorded, and the only thing in between is tool
					// execution. That is a fact about today's phase order, which a
					// later phase inserted here would change silently — and the
					// symptom would be a step attributed to a member that first
					// served the turn after it, which is the class of wrongness
					// this whole field exists to end.
					const servedBy: StepProvenance = ((): StepProvenance => {
						const member = this.ctx.servingMember?.() ?? {
							index: 0,
							providerId: this.ctx.provider.id,
						}
						return {
							providerId: member.providerId,
							// A member declared without a model asked for the model the
							// step named — which is what the decorator does with the
							// request, so this is a reading of it and not a guess.
							model: member.model ?? stepModel,
							chainIndex: member.index,
						}
					})()
					stepServedBy = servedBy

					// Main-loop turn: also records the prompt size compaction reads.
					//
					// `servedBy` is what prices it, and it is the exact pair —
					// the member at the cursor when the stream ended, and the
					// model it was asked for. This is the seam that ended the
					// always-zero cost: the rate lookup happens per turn,
					// against who actually answered, rather than against one
					// table the run was constructed with.
					runMgr.recordTurnUsage(response.usage, {
						providerId: servedBy.providerId,
						model: servedBy.model,
					})

					// The turn went through, so the run is not sitting on an
					// irreducible prompt any more. Re-arm relief for the next one.
					overflowRelieved = false

					if (this.ctx.pluginManager) {
						const hookResults = await this.ctx.pluginManager.executeHooks(
							'post_llm_call',
							{
								runId: runMgr.id,
								iteration: iterationNum,
								response: Object.freeze({
									content: response.message.content,
									toolNames: Object.freeze(
										(response.message.toolCalls ?? []).map((c) => c.function.name),
									),
									finishReason: response.finishReason,
									usage: Object.freeze({ ...response.usage }),
								}),
							},
							this.ctx.emitEvent,
						)
						applyLifecycleHookResults('post_llm_call', hookResults)
						yield* this.ctx.drainPending()
					}

					this.ctx.log.debug('LLM response received', {
						runId: runMgr.id,
						iteration: iterationNum,
						finishReason: response.finishReason,
						hasContent: response.message.content !== null && response.message.content.length > 0,
						toolCallCount: response.message.toolCalls?.length ?? 0,
						promptTokens: response.usage.promptTokens,
						completionTokens: response.usage.completionTokens,
						totalTokens: runMgr.tokenUsage.totalTokens,
						totalCost: runMgr.costInfo.totalCost,
					})

					// The context figures ride with the spend figures because a
					// surface showing one almost always wants the other — and
					// because the two were confusable enough that a host divided
					// cumulative spend by a context window and shipped it. They
					// are measured here rather than left to be derived, since the
					// only correct derivation needs internals a host cannot see.
					//
					// Absent when the run has no compaction config: nothing then
					// resolves a window, and inventing one would be the guess this
					// replaces.
					const contextFigures = this.ctx.compactionConfig
						? (() => {
								const measured = measureContext(this.ctx)
								const window = resolveContextWindow(
									this.ctx.compactionConfig?.contextWindowTokens,
									runConfig.model,
								)
								return {
									contextTokens: measured.tokens,
									contextMeasuredBy: measured.source,
									contextWindowTokens: window.tokens,
									windowSource: window.source,
								}
							})()
						: {}

					await this.ctx.emitEvent({
						type: 'token_usage_updated',
						runId: runMgr.id,
						usage: runMgr.tokenUsage,
						cost: runMgr.costInfo,
						...contextFigures,
					})

					// Reasoning rides along with the turn it belongs to, so the
					// replay contract holds automatically: trimming or compacting
					// the assistant message takes its thinking blocks with it,
					// and no separate atomicity rule is needed.
					const assistantMsg = createAssistantMessage(
						response.message.content,
						forceFinalize ? undefined : response.message.toolCalls,
						response.message.reasoning,
						// Rides with the turn it belongs to, like reasoning does, so
						// trimming or compacting the turn takes its evidence with it
						// rather than leaving citations pointing at prose that is gone.
						response.message.citations,
					)
					runMgr.pushMessage(assistantMsg)

					if (this.ctx.workingStateManager && this.ctx.compactionConfig && assistantMsg.content) {
						extractFromAssistantMessage(
							this.ctx.workingStateManager,
							assistantMsg.content,
							this.ctx.compactionConfig,
						)
					}

					yield* this.ctx.drainPending()

					iterSpan.setAttributes({
						[GENAI.USAGE_INPUT_TOKENS]: response.usage.promptTokens,
						[GENAI.USAGE_OUTPUT_TOKENS]: response.usage.completionTokens,
					})
					iterSpan.setStatus({ code: SpanStatusCode.OK })

					if (iterationActivity) {
						this.ctx.activityStore.complete(iterationActivity.id, {
							content: response.message.content,
							hasToolCalls: forceFinalize ? false : !!response.message.toolCalls?.length,
						})
					}

					// Tool calls beat the finish reason. The reason is the
					// provider's SUMMARY of the turn and the tool calls are the
					// turn itself, so when they disagree the calls are the fact.
					// Several function-calling endpoints — gateways and local servers
					// especially — report `stop` alongside a populated
					// `tool_calls`, and three of this repo's drivers pass that
					// value through untouched.
					//
					// Reading `stop` first meant the turn ended with every
					// requested call silently skipped, an assistant message
					// carrying tool_use blocks that were never answered, and a
					// run that settled `end_turn` having done nothing it was
					// asked to do. Checking the calls first costs nothing when
					// the provider is honest and is the only thing that saves the
					// run when it is not.
					const hasToolCalls = (response.message.toolCalls?.length ?? 0) > 0

					if (forceFinalize || !hasToolCalls) {
						// Every task-dispatch tool (create_task, continue_task, Agent)
						// is BLOCKING: the worker's output returns as the dispatching
						// tool_use's canonical tool_result, so by the time the model
						// ends its turn nothing launched by this run should still be
						// in flight. A running task here is an orphan (interrupted
						// tool execution, cancel race) with no delivery path back to
						// the parent — the <task-notification> producer was removed
						// in dc16d58, so waiting on the queue could only ever time
						// out. Log the orphans honestly and end the turn normally.
						if (!forceFinalize && this.hasRunningAgentTasks()) {
							this.ctx.log.warn(
								'LLM ended turn with agent tasks still running — ending run without waiting (orphan tasks have no delivery path)',
								{
									runId: runMgr.id,
									iteration: iterationNum,
								},
							)
						}

						// This iteration gets a step too.
						//
						// It did not, and the ledger's own contract said it should:
						// `StepResult` is documented as "what one iteration of the
						// agent loop did" and `stepNumber` as "1-based, matching
						// `iteration` on the run events". Every path below emits
						// `iteration_completed` with this iteration's number, and
						// none of them recorded a step — so the events said
						// iteration N happened and `steps` had no entry N. The
						// invariant was not a definition anyone chose; it was
						// already false.
						//
						// What it cost: measured on a two-iteration run, one tool
						// call then an answer, 220 of 330 tokens belonged to no
						// step. That is not a rounding error and it is structurally
						// the worst turn to lose — the answering turn carries the
						// largest prompt, so the unattributed share GROWS with
						// context length.
						//
						// Recorded HERE, at the top of the branch, rather than at
						// each of its exits. Every path out of this block is a
						// `continue`, a `break` or a `return`, so one call covers
						// the terminal answer, the forced-final summary, the
						// auto-continuation, the structured-output re-prompt and the
						// answer-review rejection — all of which spend a turn's
						// tokens. Placing it at the exits instead would be five call
						// sites to keep in agreement, and the one added later would
						// be the one that got missed.
						//
						// No tool results, because this branch is defined by their
						// absence. `toolExecutionMs` is 0 for the same reason.
						//
						// A step is an ITERATION'S MAIN TURN, and side calls are
						// still not steps — the compaction verifier, the advisory
						// executor, and the empty-completion retry a few lines below
						// all spend tokens inside an iteration without being one.
						// Their usage reaches `run.tokenUsage` and no step, so the
						// ledger reconciles with the run total for a run that makes
						// no side calls and undercounts by exactly those calls for a
						// run that does. That residual is named rather than fixed
						// here: attributing a side call needs a record that is not a
						// step, which is a different claim.

						this.recordStep({
							stepNumber: iterationNum,
							model: stepModel,
							servedBy,
							messageId,
							response,
							toolResults: [],
							toolExecutionMs: 0,
							startedAt: stepStartedAt,
							usageBefore,
							costBefore,
						})

						const hasContent =
							response.message.content !== null && response.message.content.length > 0

						// Auto-continuation on `stop_reason: max_tokens`. The
						// model hit its per-call output cap mid-text (NOT
						// mid-tool-use — that path is handled separately
						// below via `inputTruncated`). Push a synthetic
						// "continue" user message and let the loop fire
						// another turn. The provider receives the partial
						// assistant content + the continue prompt and
						// resumes from where it left off, mirroring the
						// Auto-continuation after an output-ceiling cutoff.
						//
						// Guards:
						//   - `hasContent` so we don't loop forever on an
						//     empty cutoff (a provider occasionally emits
						//     `stop_reason: max_tokens` with no content
						//     when an injected pre-fill blocks the model).
						//   - `!forceFinalize` so the forced-finalize path
						//     never auto-continues — that path is invoked
						//     specifically to extract a closing summary.
						//   - max_iterations bounds the loop in any case.
						if (!forceFinalize && response.finishReason === 'length' && hasContent) {
							this.ctx.log.info('LLM hit max_tokens mid-text — auto-continuing', {
								runId: runMgr.id,
								iteration: iterationNum,
								completionTokens: response.usage.completionTokens,
							})
							runMgr.pushMessage(createUserMessage(AUTO_CONTINUATION_USER_MESSAGE))
							await this.ctx.emitEvent({
								type: 'iteration_completed',
								runId: runMgr.id,
								iteration: iterationNum,
								hasToolCalls: false,
							})
							yield* this.ctx.drainPending()
							continue
						}

						// The model tried to finish in prose while a structured
						// output was demanded. Send it back with the schema error
						// rather than returning an unusable result — this is the
						// re-prompt half, and it is bounded so a model that cannot
						// satisfy the schema fails loudly instead of looping.
						if (!forceFinalize && this.needsStructuredOutput()) {
							const attempt = ++this.structuredOutputAttempts
							const limit = this.structuredOutputRetryLimit()
							if (attempt > limit) {
								this.ctx.log.warn('Structured output not produced within its retries', {
									runId: runMgr.id,
									attempts: attempt - 1,
								})
								runMgr.setStopReason('structured_output_failed')
								break
							}
							this.ctx.log.info('Re-prompting for structured output', {
								runId: runMgr.id,
								attempt,
								limit,
							})
							runMgr.pushMessage(createUserMessage(STRUCTURED_OUTPUT_REPROMPT))
							await this.ctx.emitEvent({
								type: 'iteration_completed',
								runId: runMgr.id,
								iteration: iterationNum,
								hasToolCalls: false,
							})
							yield* this.ctx.drainPending()
							continue
						}

						// Let the host judge the ANSWER and hand back work.
						//
						// The stop predicate is only consulted after tools ran, so
						// there was no seam here at all: the moment the model
						// stopped calling tools the run finalized, whatever it had
						// produced. Verify-then-fix — run the build, feed the
						// failure back, let it try again — meant starting a whole
						// new run and re-supplying the context the first one had.
						//
						// Shaped after the structured-output re-prompt directly
						// above, which solves the same problem for one specific
						// judge: bounded attempts, feedback as a user message, and
						// a loud stop rather than a loop.
						if (!forceFinalize && this.ctx.reviewAnswer) {
							const review = await this.reviewAnswer(response.message.content ?? '')
							if (review && !review.accept) {
								const attempt = ++this.answerReviewAttempts
								const limit = this.ctx.maxAnswerReviews ?? DEFAULT_ANSWER_REVIEW_LIMIT
								if (attempt > limit) {
									this.ctx.log.warn('Answer rejected more times than the run allows', {
										runId: runMgr.id,
										attempts: attempt - 1,
										limit,
									})
									runMgr.setStopReason('answer_rejected')
									break
								}
								this.ctx.log.info('Answer rejected — returning it to the model', {
									runId: runMgr.id,
									attempt,
									limit,
								})
								runMgr.pushMessage(createUserMessage(review.feedback))
								await this.ctx.emitEvent({
									type: 'iteration_completed',
									runId: runMgr.id,
									iteration: iterationNum,
									hasToolCalls: false,
								})
								yield* this.ctx.drainPending()
								continue
							}
						}

						// A background worker is still out there, and this turn was
						// about to end the run.
						//
						// Settling here would throw away the very thing the launch
						// existed to produce: the supervisor said "launched", the
						// worker had not finished, and the run closed over it.
						if (!forceFinalize && (yield* this.holdForOutstandingWork(iterationNum, false))) {
							continue
						}

						if (!hasContent && !forceFinalize) {
							this.ctx.log.warn('Empty completion detected — requesting final summary', {
								iteration: iterationNum,
								finishReason: response.finishReason,
							})
							await this.requestFinalResponse(model, 'end_turn')
							yield* this.ctx.drainPending()
						}

						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: false,
						})
						yield* this.ctx.drainPending()
						// A Stop that lands AFTER the final turn streamed but before
						// this break must settle the run as cancelled, not end_turn —
						// otherwise the just-produced answer is recorded as a clean
						// completion. Mirrors the between-iteration cancel at :511.
						if (this.ctx.abortController.signal.aborted) {
							runMgr.setStopReason('cancelled')
							runMgr.markCancelled()
							break
						}
						// The host's stop predicate, if the previous turn deferred it
						// to let the model read a delegated result. That extra turn
						// is prose, and `stopWhen` is consulted only after a tool
						// batch, so the predicate is never asked again — reporting
						// `end_turn` would name the shape of the last message rather
						// than the reason the run is over.
						//
						// Only here. A terminal tool and a captured structured output
						// also settle as `end_turn`, and there the deferred predicate
						// is not why the run ended: those decided the answer
						// themselves.
						runMgr.setStopReason(stopWasDeferredForOutstandingWork ? 'stop_condition' : 'end_turn')
						break
					}

					const reviewOutcome = yield* runToolReview(this.ctx, response, iterationNum)

					// The step record is built even for a rejected batch: a run that
					// spent a turn getting its tools refused still spent the tokens,
					// and a caller reconstructing cost per step must see it.
					this.recordStep({
						stepNumber: iterationNum,
						// The model this step ASKED for. It used to be `model`, the
						// run's own — so a `prepareStep` that routed one step to a
						// cheaper model was recorded as the expensive one, with no
						// provider chain involved.
						model: stepModel,
						servedBy,
						messageId,
						response,
						toolResults: reviewOutcome.results,
						toolExecutionMs: reviewOutcome.durationMs,
						startedAt: stepStartedAt,
						usageBefore,
						costBefore,
					})

					if (reviewOutcome.decision === 'stop') {
						return
					}

					if (reviewOutcome.decision === 'rejected') {
						continue
					}

					// A successful `structured_output` call IS the answer, so the
					// run ends here rather than paying for another turn whose only
					// job would be to restate it — unless it shared its turn with
					// other calls, which relays instead. See the method.
					if (this.captureStructuredOutput(reviewOutcome.results, response)) {
						this.ctx.log.info('Structured output produced — ending run', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
						runMgr.setStopReason('end_turn')
						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: true,
						})
						yield* this.ctx.drainPending()
						break
					}

					// A tool the author declared terminal settles the run with its
					// own output, the same rule `structured_output` has always
					// had. Without it a delegation cost the parent one more model
					// call at full context whose only job was to restate what the
					// worker already said — and to restate it through the parent's
					// compacted view, so the caller did not even receive the
					// worker's words.
					const settled = this.terminalToolOutput(reviewOutcome.results, response)
					if (settled !== undefined) {
						this.ctx.log.info('Terminal tool produced the answer — ending run', {
							runId: runMgr.id,
							iteration: iterationNum,
							tool: settled.toolName,
						})
						runMgr.setResult(settled.output)
						runMgr.setStopReason('end_turn')
						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: true,
						})
						yield* this.ctx.drainPending()
						break
					}

					// Evaluated AFTER the tools ran, so a predicate can see what they
					// returned — which is what makes a terminal submit_answer tool
					// usable without discarding its output.
					if (await this.shouldStop()) {
						// Outstanding delegated work outranks the host's stop
						// predicate, exactly once.
						//
						// This is a precedence rule chosen here, not something
						// `stopWhen` implies — a stop predicate is a programmable
						// halt and says nothing about whether the answer is
						// complete, which is what separates it from a terminal
						// tool or a captured structured output. Those decide the
						// result, so no turn follows and a hold would buy nothing.
						// This one only says "stop", and stopping one turn later
						// with the worker's result in hand is a better reading of
						// the host's intent than stopping now and discarding it.
						//
						// Bounded: after the notification is delivered the inbox
						// is drained, so the predicate fires again next turn with
						// nothing pending and the run stops. Exactly one extra
						// turn, and `maxIterations` bounds it regardless.
						if (yield* this.holdForOutstandingWork(iterationNum, true)) {
							// Remember WHY the next turn exists, so the turn that
							// ends the run can name the host's decision instead of
							// reporting the shape of the last message.
							this.stopDeferredForOutstandingWork = true
							continue
						}

						this.ctx.log.info('Stop condition met', {
							runId: runMgr.id,
							iteration: iterationNum,
						})
						runMgr.setStopReason('stop_condition')
						await this.ctx.emitEvent({
							type: 'iteration_completed',
							runId: runMgr.id,
							iteration: iterationNum,
							hasToolCalls: true,
						})
						yield* this.ctx.drainPending()
						break
					}

					const checkpointSignal = yield* runIterationCheckpoint(this.ctx, iterationNum)
					if (checkpointSignal === 'stop') {
						return
					}

					// Workers that finished with nobody listening.
					//
					// A completion normally reaches the supervisor as the
					// `tool_result` of the `create_task` that launched it. Two
					// cases have no such call: a launch made in the background on
					// purpose, and a blocking launch whose deadline passed — the
					// model was told "timed out, it may still be running" and the
					// worker then finished, holding a result nothing would read.
					//
					// This is the channel that was removed in `dc16d58` because it
					// double-delivered: it fired for completions the blocking tool
					// had already handed over, so the supervisor saw each result
					// twice. The inbox restores it with the distinction that was
					// missing — a tool that delivers a completion claims it, and
					// only unclaimed ones arrive here.
					//
					// Placed beside the advisory phase deliberately: that is the
					// established seam for putting a user message in after tool
					// results and before the next turn.
					const unheard = this.ctx.completionInbox?.drain() ?? []
					if (unheard.length > 0) {
						this.ctx.log.info('Delivering unawaited task completions', {
							runId: runMgr.id,
							iteration: iterationNum,
							tasks: unheard.map((h) => h.taskId),
						})
						runMgr.pushMessage(createUserMessage(formatCompletionNotification(unheard)))
					}

					await runAdvisoryPhase(this.ctx, iterationNum, response)

					if (this.ctx.pluginManager) {
						const hookResults = await this.ctx.pluginManager.executeHooks(
							'iteration_end',
							{ runId: runMgr.id, iteration: iterationNum },
							this.ctx.emitEvent,
						)
						applyLifecycleHookResults('iteration_end', hookResults)
						yield* this.ctx.drainPending()
					}

					await this.ctx.emitEvent({
						type: 'iteration_completed',
						runId: runMgr.id,
						iteration: iterationNum,
						hasToolCalls: true,
					})
					yield* this.ctx.drainPending()
				} catch (err) {
					const cancelled = this.ctx.abortController.signal.aborted

					// This iteration gets a step too, and it is the one the
					// argument three hundred lines above was actually about.
					//
					// That docblock makes the case for a rejected tool batch — "a
					// run that spent a turn getting its tools refused still spent
					// the tokens" — and every call site it produced sat on a
					// success path. So the ledger was complete except on the turns
					// that failed, which is the worst shape it could have: an
					// evidence record that goes quiet exactly where something went
					// wrong reads as "nothing went wrong". A reader could not
					// distinguish iteration N failing from iteration N never
					// happening, while the events said plainly that it started.
					//
					// Recorded HERE, at the top of the catch, rather than at each
					// of its exits — the same reasoning the success path already
					// wrote down for itself. All three exits spend a turn: the
					// cancellation breaks, the overflow-relief retry continues
					// under a NEW iteration number (so its tokens belong to no
					// later step), and the re-throw ends the run.
					//
					// What it carries is what the iteration got as far as knowing.
					// `usage` is the same subtraction a successful step makes, so
					// a turn that failed after the provider answered carries that
					// answer's tokens, and one that failed before it carries the
					// zero it actually spent. Nothing is estimated to fill a gap.
					//
					// At most ONE step per iteration. Both success paths record
					// before the work that follows them — the advisory phase, the
					// structured-output capture, the `iteration_end` hooks, the
					// terminal `iteration_completed` — and any of those can throw
					// into here. A second entry numbered N would double-count that
					// turn's tokens against `run.tokenUsage`, which is the same
					// class of wrong as dropping them and harder to notice, since
					// the ledger would look fuller rather than emptier. That turn's
					// own verdict is already written down; the failure that
					// followed it reaches the caller as the run's error.
					if (this.steps.at(-1)?.stepNumber === iterationNum) {
						this.ctx.log.warn('Iteration failed after its step was already recorded', {
							runId: runMgr.id,
							iteration: iterationNum,
							error: toErrorMessage(err),
						})
					} else {
						this.recordStep({
							stepNumber: iterationNum,
							model: stepModel,
							...(stepServedBy ? { servedBy: stepServedBy } : {}),
							...(stepMessageId ? { messageId: stepMessageId } : {}),
							...(stepResponse ? { response: stepResponse } : {}),
							// Tool outcomes are produced and returned together by
							// `runToolReview`, so a throw from inside it leaves none
							// to salvage: an empty list here means "none came back",
							// which is what the shorter-than-`toolCalls` contract
							// says.
							toolResults: [],
							toolExecutionMs: 0,
							startedAt: stepStartedAt,
							usageBefore,
							costBefore,
							unfinished: cancelled
								? { finishReason: 'cancelled' }
								: {
										finishReason: 'error',
										failure: describeStepFailure(err, this.ctx.provider.id),
									},
						})
					}

					// A Stop that aborted the in-flight turn surfaces here as a
					// thrown abort (the provider stream was raced against the run
					// signal). Settle it as a CANCELLATION — mirroring the
					// between-iteration cancel at the top of the loop — rather than
					// recording it as an SDK failure (error span + failed activity)
					// and re-throwing. The run then returns cleanly with a
					// 'cancelled' stop reason instead of propagating an error.
					if (cancelled) {
						runMgr.setStopReason('cancelled')
						runMgr.markCancelled()
						break
					}

					// The one provider failure the kernel can actually do something
					// about. `context_length_exceeded` is correctly non-retryable —
					// resending the identical prompt cannot help — but the kernel
					// owns a compaction subsystem that can make the prompt smaller.
					// Without this the run died holding the remedy: the threshold
					// path had simply guessed low, which a run carrying images or a
					// language the chars-per-token ratio does not fit will do.
					//
					// Relief is attempted ONCE per iteration and only when it
					// actually shed something. A second overflow after a successful
					// compaction means the prompt is irreducible, and looping on it
					// would burn the budget to arrive at the same error.
					if (
						!overflowRelieved &&
						classifyProviderError(err, this.ctx.provider.id).code === 'context_length_exceeded'
					) {
						overflowRelieved = true
						const shed = await relieveOverflow(this.ctx)
						if (shed) {
							this.ctx.log.info('Retrying the turn after relieving a context overflow', {
								runId: runMgr.id,
								iteration: iterationNum,
							})
							if (iterationActivity) {
								this.ctx.activityStore.complete(iterationActivity.id)
							}
							continue
						}
					}

					if (iterationActivity) {
						this.ctx.activityStore.fail(iterationActivity.id, toErrorMessage(err))
					}

					iterSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: toErrorMessage(err),
					})
					iterSpan.recordException(err instanceof Error ? err : new Error(String(err)))
					throw err
				} finally {
					// The only place the iteration span ends. It used to be ended at each of
					// seventeen exits, which is a rule every future edit has to
					// remember; a generator abandoned by its consumer never reached
					// any of them.
					iterSpan.end()
				}
			}
		} finally {
			this.settleOutstandingWork()
		}
	}

	/**
	 * Hold the run open for a worker that has not finished, and deliver it.
	 *
	 * Returns whether a completion arrived and was put in the transcript — the
	 * caller continues the loop on `true`, so the model gets a turn in which to
	 * USE the result. That turn is the entire justification for waiting, which
	 * is why only the exits that can still take one call this.
	 *
	 * Bounded by `settleGraceMs` and by `maxIterations`, so a worker that never
	 * finishes cannot keep the run open.
	 */
	private async *holdForOutstandingWork(
		iterationNum: number,
		hasToolCalls: boolean,
	): AsyncGenerator<RunEvent, boolean> {
		if (!this.ctx.completionInbox?.hasPendingWork) return false

		// Read HERE rather than from `forceFinalize`, which was sampled at the
		// top of the iteration: one that has since crossed the finalize point
		// must not open a wait against a reserve it has already entered.
		const graceMs = settleGraceMs(this.ctx.guard.remainingBeforeFinalizeMs())
		this.ctx.log.info('Holding the run open for a background task', {
			runId: this.ctx.runMgr.id,
			iteration: iterationNum,
			graceMs,
		})
		await this.ctx.completionInbox.waitForArrival(graceMs)

		const arrived = this.ctx.completionInbox.drain()
		if (arrived.length === 0) return false

		this.ctx.runMgr.pushMessage(createUserMessage(formatCompletionNotification(arrived)))
		await this.ctx.emitEvent({
			type: 'iteration_completed',
			runId: this.ctx.runMgr.id,
			iteration: iterationNum,
			hasToolCalls,
		})
		yield* this.ctx.drainPending()
		return true
	}

	/**
	 * Account for delegated work on the way out: deliver what arrived, and say
	 * what did not.
	 *
	 * A run that ends with a worker outstanding must not leave the impression
	 * that the worker's result was delivered. There are exactly two honest
	 * outcomes and this does both:
	 *
	 *  - **What has already arrived is delivered.** It makes no false claim,
	 *    and dropping it is pure loss — the message rides out on
	 *    `Run.messages`, so a host reads it and the next turn of a continued
	 *    thread starts with it. This does NOT wait: a hold buys the model a
	 *    turn in which to USE a result, and on an exit whose answer is already
	 *    decided there is no such turn, so waiting would delay a settled answer
	 *    to append text this run will not read. The bounded hold stays where it
	 *    was, on the exits that do have a turn left.
	 *  - **What is still running is NAMED, not cancelled.** Giving up on a wait
	 *    is a statement about the waiter, not about the work — the rule
	 *    `wait-with-idle-bound.ts` already states for the same subsystem — and
	 *    "the parent answered early" is a weaker warrant for killing a child
	 *    than "the clock ran out", not a stronger one. Killing a worker that
	 *    may be mid-write is a policy only the host can judge, and it has
	 *    `cancel_task` and the run controller to judge it with.
	 */
	private settleOutstandingWork(): void {
		this.deliverArrivedCompletions()
		this.recordAbandonedWork()
	}

	/** Delegated work this run walked away from. See {@link settleOutstandingWork}. */
	private recordAbandonedWork(): void {
		const abandoned = this.ctx.completionInbox?.outstandingTaskIds ?? []
		if (abandoned.length === 0) return

		this.ctx.log.warn('Run ended with delegated work still running', {
			runId: this.ctx.runMgr.id,
			tasks: abandoned,
		})
		this.ctx.runMgr.setAbandonedTaskIds(abandoned)
	}

	private deliverArrivedCompletions(): void {
		const unheard = this.ctx.completionInbox?.drain() ?? []
		if (unheard.length === 0) return

		// Fix the run's answer BEFORE appending anything after it.
		//
		// `RunPersistence.resolveResult` walks the message tail backwards and
		// stops at the first non-assistant message, and it runs at
		// `markCompleted` — which is AFTER this. So a notification appended
		// after the final assistant turn makes the run's own answer
		// unreachable. Measured, on a run whose model had just said "THIS IS
		// THE RUN ANSWER.": `run.result` came back `undefined`. That trades a
		// lost worker result for a lost RUN result, which is strictly worse
		// than the defect this delivery exists to fix.
		//
		// Materialising resolves it while the tail is still the assistant's;
		// pinning it means the later re-resolution cannot undo the fix. Only
		// when there is something to pin: on the cancelled and thrown paths
		// there may be no answer, and pinning an empty string there would
		// suppress whatever the error path assembles.
		const answer = this.ctx.runMgr.materializeResult()
		if (answer.length > 0) this.ctx.runMgr.setResult(answer)

		this.ctx.log.info('Delivering task completions the run would have settled over', {
			runId: this.ctx.runMgr.id,
			tasks: unheard.map((h) => h.taskId),
		})
		this.ctx.runMgr.pushMessage(createUserMessage(formatCompletionNotification(unheard)))
	}

	/**
	 * Ask the host how to shape this step.
	 *
	 * Fails OPEN on a throw — same reasoning as `stopWhen` and deliberately
	 * opposite to a guardrail: a broken step-shaping hook should not kill an
	 * otherwise healthy run, and unlike a safety check, nothing unsafe gets
	 * through when it is skipped.
	 */
	/**
	 * A host's chance to refuse the next model call.
	 *
	 * Fails CLOSED, which is the opposite of `prepareStep` below and the
	 * reason they are separate hooks rather than one with two return
	 * shapes. A broken step-SHAPER skipped costs a run its per-step tuning;
	 * a broken step-REFUSER skipped is a refusal that did not happen, which
	 * is precisely what the hook exists to prevent. The thrown error's
	 * message becomes the reason, so an operator is not left with a run
	 * that stopped and no account of it.
	 */
	private async beforeStep(stepNumber: number): Promise<StepVeto | undefined> {
		const configured = this.ctx.beforeStep
		if (!configured) return undefined
		try {
			return (
				(await configured({
					runId: this.ctx.runMgr.id,
					stepNumber,
					messages: this.ctx.runMgr.messages,
					steps: this.steps,
					prepared: {},
				})) ?? undefined
			)
		} catch (err) {
			return { reason: `beforeStep threw: ${toErrorMessage(err)}` }
		}
	}

	private async prepareStep(stepNumber: number): Promise<{
		allowedTools?: string[]
		toolChoice?: ToolChoice
		model?: string
		system?: string
		skills?: readonly Skill[]
		temperature?: number
		maxResponseTokens?: number
	}> {
		const configured = this.ctx.prepareStep
		if (!configured) return {}
		const stages = Array.isArray(configured) ? configured : [configured]

		// Folded in DECLARATION order, each stage seeing what the ones
		// before it decided. A later stage overriding a field is last-writer
		// wins — visibly, because the order is a line in the host's code
		// rather than an accident of install history.
		let result: PrepareStepResult = {}
		for (const stage of stages) {
			try {
				const decided = await stage({
					runId: this.ctx.runMgr.id,
					stepNumber,
					messages: this.ctx.runMgr.messages,
					steps: this.steps,
					prepared: result,
				})
				if (decided) result = { ...result, ...decided }
			} catch (err) {
				// Skipped, and the rest still run: one broken concern must
				// not silently disable the others it was declared beside.
				this.ctx.log.error('a prepareStep stage threw — skipping it', {
					runId: this.ctx.runMgr.id,
					stepNumber,
					error: toErrorMessage(err),
				})
			}
		}

		const prepared: {
			allowedTools?: string[]
			toolChoice?: ToolChoice
			model?: string
			system?: string
			skills?: readonly Skill[]
			temperature?: number
			maxResponseTokens?: number
		} = {}

		if (result.activeTools) {
			const known = result.activeTools.filter((name: string) => this.ctx.tools.has(name))
			const unknown = result.activeTools.filter((name: string) => !this.ctx.tools.has(name))
			if (unknown.length > 0) {
				// The all-unknown case gets its own sentence because it has its
				// own consequence. Some names dropped narrows the step; ALL of
				// them dropped leaves it able to call nothing — which is the
				// honest reading of "only these tools" when none of them exist,
				// and is not what a reader of "ignoring them" would expect.
				//
				// Widening back to the run's list would be worse: it grants
				// exactly the tools the caller asked to exclude, on the grounds
				// that their own list failed. A step that can call nothing is
				// constrained; a step that can call everything is a control
				// that stopped applying.
				const message =
					known.length === 0
						? 'prepareStep named only tools that are not registered — this step can call nothing'
						: 'prepareStep named tools that are not registered — ignoring them'
				this.ctx.log.warn(message, {
					runId: this.ctx.runMgr.id,
					stepNumber,
					unknown,
					remaining: known.length,
				})
			}
			prepared.allowedTools = known
		}
		if (result.toolChoice !== undefined) prepared.toolChoice = result.toolChoice
		if (result.model !== undefined) prepared.model = result.model
		if (result.system !== undefined) prepared.system = result.system
		if (result.skills !== undefined) prepared.skills = result.skills
		if (result.temperature !== undefined) prepared.temperature = result.temperature
		if (result.maxResponseTokens !== undefined) {
			prepared.maxResponseTokens = result.maxResponseTokens
		}

		return prepared
	}

	/** Steps completed so far, exposed on the returned `Run`. */
	private readonly steps: StepResult[] = []

	getSteps(): readonly StepResult[] {
		return this.steps
	}

	/**
	 * Fold one iteration into a `StepResult`.
	 *
	 * Every field here was already computed somewhere in the loop; the only
	 * new work is subtracting the cumulative counters so the step carries
	 * ITS usage rather than the run's running total, which is the number a
	 * caller asking "what did this step cost" actually wants.
	 */
	private recordStep(input: {
		stepNumber: number
		model: string
		servedBy?: StepProvenance
		messageId?: MessageId
		/**
		 * The turn's response. Absent only when the iteration failed before
		 * the provider produced one — see `unfinished`.
		 */
		response?: ChatCompletionResponse
		toolResults: readonly ToolCallOutcome[]
		toolExecutionMs: number
		startedAt: number
		usageBefore: TokenUsage
		costBefore: CostInfo
		/**
		 * Set only by the `catch`, for an iteration that did not finish.
		 *
		 * The same writer builds both records on purpose: a failed turn's
		 * step is a `StepResult` like any other, so a caller reconstructing
		 * cost or history sorts them together instead of discovering that
		 * failures live somewhere else.
		 */
		unfinished?: { finishReason: 'error' | 'cancelled'; failure?: StepFailure }
	}): void {
		const { runMgr } = this.ctx
		const toolCalls = input.response?.message.toolCalls ?? []
		const byId = new Map(input.toolResults.map((r) => [r.toolCallId, r]))

		const step: StepResult = {
			stepNumber: input.stepNumber,
			model: input.model,
			...(input.servedBy ? { servedBy: input.servedBy } : {}),
			...(input.messageId ? { messageId: input.messageId } : {}),
			content: input.response?.message.content ?? null,
			toolCalls,
			// Ordered by the tool CALLS, not by completion, so the record
			// matches what the model asked for.
			//
			// On an unfinished step the calls with no outcome are DROPPED
			// rather than filled with `{output: '', isError: false}`. That
			// filler is a reading of "the batch was refused" on the success
			// path, where every call in a batch shares one verdict; under a
			// step that says `error` it would say a tool ran and returned
			// nothing successfully, which is the same lie one level down as
			// the missing step itself.
			toolResults: toolCalls.flatMap((tc) => {
				const outcome = byId.get(tc.id)
				if (input.unfinished && !outcome) return []
				return [
					{
						toolCallId: tc.id,
						toolName: tc.function.name,
						output: outcome?.output ?? '',
						isError: outcome?.isError ?? false,
						durationMs: 0,
					},
				]
			}),
			// The turn's own verdict where there is one. A step that ended in
			// the catch has none — no provider reported `error` or
			// `cancelled` — so `unfinished` wins even when a response had
			// already arrived: a turn that answered and then threw during
			// tool execution did not end in `tool_calls`.
			finishReason: input.unfinished?.finishReason ?? input.response?.finishReason ?? 'error',
			...(input.unfinished?.failure ? { failure: input.unfinished.failure } : {}),
			usage: subtractUsage(runMgr.tokenUsage, input.usageBefore),
			costDelta: {
				...runMgr.costInfo,
				totalCost: round6(runMgr.costInfo.totalCost - input.costBefore.totalCost),
			},
			startedAt: input.startedAt,
			durationMs: Date.now() - input.startedAt,
			toolExecutionMs: input.toolExecutionMs,
		}

		this.steps.push(step)

		if (!input.unfinished) {
			this.ctx.onStepFinish?.(step)
			return
		}

		// Nothing here is allowed to throw over the failure that is already
		// unwinding — the same rule `settleCancelledTurn` states for the
		// cancellation path. A host callback that throws while being told a
		// turn failed would REPLACE the reason the turn failed, so the run
		// would report the observer's bug and lose the original.
		try {
			this.ctx.onStepFinish?.(step)
		} catch (err) {
			this.ctx.log.warn('onStepFinish threw while recording a failed step', {
				runId: runMgr.id,
				step: input.stepNumber,
				error: toErrorMessage(err),
			})
		}
	}

	/** Turns spent asking the model again for a valid structured output. */
	private structuredOutputAttempts = 0
	private structuredOutputDone = false

	private structuredOutputRetryLimit(): number {
		return this.ctx.structuredOutput?.maxRetries ?? DEFAULT_STRUCTURED_OUTPUT_RETRIES
	}

	/** True while a structured output was demanded and has not arrived. */
	private needsStructuredOutput(): boolean {
		return this.ctx.structuredOutput !== undefined && !this.structuredOutputDone
	}

	/**
	 * The answer a terminal tool produced, or `undefined` to keep looping.
	 *
	 * Deliberately narrow. A terminal call decides the run only when it is
	 * the ONLY call the model made in that turn: a model that asked for
	 * other work meant to see those results, and settling here would throw
	 * away answers it requested. Same for a failed terminal call — an
	 * error is not an answer, and the model is the one that should read
	 * it. Both cases fall through to the ordinary path, and both say so in
	 * the log rather than quietly costing the relay the flag was set to
	 * avoid.
	 */
	private terminalToolOutput(
		results: readonly ToolCallOutcome[],
		response: ChatCompletionResponse,
	): ToolCallOutcome | undefined {
		const terminal = results.filter((r) => this.ctx.tools.get(r.toolName)?.terminal === true)
		if (terminal.length === 0) return undefined

		const callCount = response.message.toolCalls?.length ?? 0
		if (callCount > 1) {
			this.ctx.log.info('Terminal tool shared its turn — relaying instead of settling', {
				runId: this.ctx.runMgr.id,
				tool: terminal[0]?.toolName,
				callsInTurn: callCount,
			})
			return undefined
		}

		const hit = terminal[0]
		if (!hit || hit.isError) {
			this.ctx.log.info('Terminal tool failed — returning the error to the model', {
				runId: this.ctx.runMgr.id,
				tool: hit?.toolName,
			})
			return undefined
		}
		return hit
	}

	/**
	 * Record the structured output if this batch produced one.
	 *
	 * The tool validates against the Zod schema before its `execute` runs,
	 * so reaching here successfully means the value is already valid — a
	 * failed parse comes back as an error result and simply does not
	 * satisfy the demand, which sends the loop round again.
	 *
	 * Narrow in the same way {@link terminalToolOutput} is, for its stated
	 * reason and one that is sharper here. The neighbour refuses a shared
	 * turn because "a model that asked for other work meant to see those
	 * results". That applies unchanged. But the batch has ALREADY executed
	 * by the time this runs — `runToolReview` settles it, side effects
	 * included, before either of these is consulted — so settling here is
	 * worse than discarding an answer the model wanted: the work happened,
	 * its results went into the transcript, and the run ended before any
	 * model turn could read them. Nothing consumed what was spent, and
	 * nothing said so.
	 *
	 * Sharper, too, because of WHEN this value was produced. The model
	 * emitted its final answer in the same turn as a request for
	 * information it had not yet received — it would not have asked
	 * otherwise — so the answer is under-informed on the model's own
	 * account, and settling ships it as final.
	 *
	 * So: relay, do not settle. The results are already in the transcript,
	 * the demand is still unsatisfied, and the next turn produces the
	 * answer with them in hand. Refusing to EXECUTE the batch was the other
	 * candidate and is wrong — the defect is not that the tools ran, it is
	 * that nobody read them, and denying a model work it asked for to
	 * protect an answer it has not finished forming gives up a real
	 * capability for nothing. The price is one extra turn when the paired
	 * call was a pure side effect whose result the model did not need;
	 * that is the price `terminalToolOutput` already pays, and a model
	 * avoids it by not pairing.
	 *
	 * NOT charged to `maxRetries`. That budget bounds a model that cannot
	 * satisfy the SCHEMA, and this one did. A run reading two files a turn
	 * while optimistically attaching its answer is making progress, and it
	 * must not die reported as `structured_output_failed` — a failure that
	 * did not happen. `maxIterations` is the bound for a model that keeps
	 * doing work, and it is the bound the neighbour relies on for the
	 * identical pathology.
	 */
	private captureStructuredOutput(
		results: readonly ToolCallOutcome[],
		response: ChatCompletionResponse,
	): boolean {
		if (!this.needsStructuredOutput()) return false
		const hit = results.find((r) => r.toolName === STRUCTURED_OUTPUT_TOOL_NAME && !r.isError)
		if (!hit) return false

		const callCount = response.message.toolCalls?.length ?? 0
		if (callCount > 1) {
			this.ctx.log.info('Structured output shared its turn — relaying instead of settling', {
				runId: this.ctx.runMgr.id,
				callsInTurn: callCount,
			})
			return false
		}

		try {
			this.ctx.runMgr.setStructuredOutput(JSON.parse(hit.output))
		} catch {
			// The tool serializes its own validated input, so this is
			// unreachable in practice; keep the raw text rather than losing it.
			this.ctx.runMgr.setStructuredOutput(hit.output)
		}
		this.structuredOutputDone = true
		return true
	}

	/**
	 * Ask the host whether this answer is good enough.
	 *
	 * A hook that throws **accepts**, which is the opposite of what the
	 * safety gates do, and deliberately so. Those are asked "is this
	 * dangerous", where the cost of failing closed is one refused
	 * operation. This is asked "is this good enough", where failing closed
	 * means handing the answer back forever — so a broken judge would turn
	 * every run into a loop that ends on a budget error naming nothing. One
	 * unreviewed answer is the cheaper failure, and the throw is logged at
	 * `error` so it is not mistaken for approval.
	 */
	private async reviewAnswer(answer: string): Promise<AnswerReview | undefined> {
		if (!this.ctx.reviewAnswer) return undefined
		try {
			return await this.ctx.reviewAnswer(answer, {
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messages: this.ctx.runMgr.messages,
			})
		} catch (err) {
			this.ctx.log.error('Answer review threw — accepting the answer unreviewed', {
				runId: this.ctx.runMgr.id,
				error: toErrorMessage(err),
			})
			return { accept: true }
		}
	}

	/** Evaluate the caller's halt predicate, if there is one. */
	private async shouldStop(): Promise<boolean> {
		const stopWhen = this.ctx.stopWhen
		const latestStep = this.steps.at(-1)
		if (!stopWhen || !latestStep) return false
		try {
			return await stopWhen({
				steps: this.steps,
				latestStep,
				totalUsage: this.ctx.runMgr.tokenUsage,
				totalCost: this.ctx.runMgr.costInfo,
			})
		} catch (err) {
			// A throwing predicate must not kill a run that is otherwise
			// healthy; failing open keeps the existing budgets in charge.
			this.ctx.log.error('Stop condition threw — continuing the run', {
				runId: this.ctx.runMgr.id,
				error: toErrorMessage(err),
			})
			return false
		}
	}

	private hasRunningAgentTasks(): boolean {
		if (!this.ctx.taskGateway) return false
		return this.ctx.taskGateway
			.listTasks()
			.some((t) => t.state !== 'completed' && t.state !== 'failed' && t.state !== 'canceled')
	}

	private async requestFinalResponse(model: string, reason: StopReason): Promise<void> {
		const lastAssistant = [...this.ctx.runMgr.messages]
			.reverse()
			.find((m) => m.role === 'assistant')

		const hasResult =
			lastAssistant?.content !== null &&
			lastAssistant?.content !== undefined &&
			lastAssistant.content.length > 0

		if (hasResult) return

		this.ctx.log.info('Requesting final response before limit enforcement', {
			reason,
		})

		try {
			const finalMessages = [
				...this.ctx.runMgr.messages,
				createUserMessage(
					`[SYSTEM] Run is ending due to ${reason}. You MUST provide a final response now summarizing all your findings and work so far. Do not use any tools.`,
				),
			]

			// Same cache discipline as the forced-final iteration: keep the
			// tools param identical to prior iterations (cache prefix intact,
			// no 400 on tool blocks in history) and forbid use via tool_choice.
			const finalTools = this.ctx.tools.toLLMTools(this.ctx.allowedTools)
			const finalEnforced = enforcedModelInputToolNames(this.ctx.tools, finalTools)
			const response = await collect(
				this.ctx.provider.chatStream({
					model,
					messages: finalMessages,
					tools: finalTools.length > 0 ? finalTools : undefined,
					...(finalEnforced ? { enforceToolInputSchema: finalEnforced } : {}),
					toolChoice: finalTools.length > 0 ? 'none' : undefined,
					temperature: this.ctx.runConfig.temperature,
					maxTokens: this.ctx.runConfig.maxResponseTokens,
					cacheControl: { type: 'auto' },
					...(this.ctx.runConfig.thinking ? { thinking: this.ctx.runConfig.thinking } : {}),
					// This turn is a hand-maintained duplicate of the one above, which
					// is exactly the shape a field goes missing from — so it is tested
					// separately rather than assumed to have been kept in step.
					...(this.ctx.runConfig.effort ? { effort: this.ctx.runConfig.effort } : {}),
					// Cancellable too: a Stop during the closing summary must not
					// stream to completion.
					signal: this.ctx.abortController.signal,
				}),
			)

			this.ctx.runMgr.accumulateUsage(response.usage, {
				providerId: this.ctx.runMgr.servingProviderId,
				model,
			})

			const assistantMsg = createAssistantMessage(response.message.content)
			this.ctx.runMgr.pushMessage(assistantMsg)

			const finalMessageId = generateMessageId()
			await this.ctx.emitEvent({
				type: 'message_started',
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messageId: finalMessageId,
			})
			await this.ctx.emitEvent({
				type: 'message_completed',
				runId: this.ctx.runMgr.id,
				iteration: this.ctx.runMgr.currentIteration,
				messageId: finalMessageId,
				stopReason: 'forced_finalize',
				usage: response.usage,
				content: response.message.content ?? undefined,
			})
		} catch (err) {
			this.ctx.log.error('Failed to get final response', {
				error: toErrorMessage(err),
			})
		}
	}
}

/**
 * Fold whatever ended an iteration into the record a reader gets.
 *
 * Classified through `classifyProviderError` — the same call the catch
 * already makes to decide whether compaction relief applies — so the step's
 * verdict and the loop's own decision cannot drift apart. It also handles a
 * failure that is not a provider failure at all: the code set's `unknown`
 * means "unclassifiable", which is the true answer for a plugin hook that
 * threw and is left saying so rather than dressed up as something specific.
 */
function describeStepFailure(err: unknown, providerId: string): StepFailure {
	const classified = classifyProviderError(err, providerId)
	return {
		message: toErrorMessage(err),
		code: classified.code,
		...(classified.status !== undefined ? { status: classified.status } : {}),
		retryable: classified.retryable,
	}
}

/** Per-step usage: the delta between two cumulative snapshots. */
function subtractUsage(after: TokenUsage, before: TokenUsage): TokenUsage {
	return {
		promptTokens: after.promptTokens - before.promptTokens,
		completionTokens: after.completionTokens - before.completionTokens,
		totalTokens: after.totalTokens - before.totalTokens,
		cachedTokens: (after.cachedTokens ?? 0) - (before.cachedTokens ?? 0),
		cacheWriteTokens: (after.cacheWriteTokens ?? 0) - (before.cacheWriteTokens ?? 0),
	}
}

/** Cost deltas are subtractions of floats; keep them presentable. */
function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6
}

/**
 * Which of the tools going out on this request have a closed model schema.
 *
 * A driver reads `enforceToolInputSchema` to decide which tool schemas to
 * constrain generation against. Nothing populated it, so every driver that
 * consumed it — three of them — was reading a permanently undefined field
 * and `enforceModelInput: true` on a tool meant nothing end to end.
 *
 * Computed per request rather than once, because the allowed set changes:
 * a deferred tool activated mid-run has to start being enforced from the
 * next call, not the next process.
 */
function enforcedModelInputToolNames(
	registry: ToolRegistryContract,
	tools: readonly LLMToolSchema[],
): readonly string[] | undefined {
	const names = tools
		.map((tool) => tool.function.name)
		.filter((name) => registry.get(name)?.enforceModelInput === true)
	return names.length > 0 ? names : undefined
}
