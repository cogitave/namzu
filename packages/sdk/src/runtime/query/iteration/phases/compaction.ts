import { resolveContextWindow } from '../../../../compaction/context-window.js'
import { findDanglingMessages } from '../../../../compaction/dangling.js'
import {
	type CompactionPlan,
	DEFAULT_SOFT_TARGET,
	planCompaction,
	planSalienceWorkingSet,
} from '../../../../compaction/plan.js'
import type { ContextReducer, ContextReduction } from '../../../../compaction/reducer.js'
import { createSlidingWindowReducer } from '../../../../compaction/reducer.js'
import { findRetainedIndices } from '../../../../compaction/retention.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { buildCompactionMessage, isCompactionMessage } from '../../../../compaction/summary.js'
import { buildVerifiedSummaryWithBoundedProvider } from '../../../../compaction/verifier.js'
import { CHARS_PER_TOKEN } from '../../../../constants/limits.js'
import { NAMZU } from '../../../../constants/telemetry/index.js'
import { invariants } from '../../../../invariants/index.js'
import { resolveTaskModel } from '../../../../model-router/task-router.js'
import type { Message } from '../../../../types/message/index.js'
import type { IterationContext } from './context.js'
import { isWorkingMemoryMessage } from './working-memory.js'

// `isCompactionMessage` and the header moved to `compaction/summary.ts` —
// this phase is a layer ABOVE that module, so nothing down there could
// reach them, and a host-callable compaction needs both. Re-exported here
// because `runtime/query/index.ts` already imports it from this path.
export { isCompactionMessage } from '../../../../compaction/summary.js'

/**
 * How much a forced pass must shed before the turn is worth retrying.
 *
 * Both floors, whichever is larger. The fraction is what makes the bar
 * scale: shedding 2 KB out of a 900 KB prompt is not relief, and retrying
 * on it spends a whole model call to be told the same thing again. The
 * absolute floor keeps a small prompt from being held to a meaningless
 * fraction of itself.
 */
const MIN_RELIEF_FRACTION = 0.02
const MIN_RELIEF_CHARS = 2_000

/**
 * Model-visible size of a message body, in characters.
 *
 * An image block is measured by its base64 payload because that is what
 * actually occupies the request. It is NOT what the model is billed for —
 * an image costs far fewer tokens than its base64 length divided by four —
 * but under-counting it to zero is the worse error: it let a run full of
 * screenshots read as an empty context.
 */
function measureContentChars(content: unknown): number {
	if (typeof content === 'string') return content.length
	if (!Array.isArray(content)) return 0
	let total = 0
	for (const block of content as readonly Record<string, unknown>[]) {
		if (block.type === 'text' && typeof block.text === 'string') total += block.text.length
		else if (block.type === 'image' && typeof block.data === 'string') total += block.data.length
	}
	return total
}

function estimateMessageTokens(messages: readonly Message[]): number {
	let chars = 0
	for (const msg of messages) {
		// `content` is `string | ToolResultBlock[]`. On an array, `.length` is
		// the BLOCK COUNT, so a tool result carrying a 400 KB screenshot
		// contributed 1 — and the estimate that decides when to compact read
		// near zero for exactly the runs that need compacting most.
		chars += measureContentChars(msg.content)
		if (msg.role === 'assistant' && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				chars += tc.function.name.length + tc.function.arguments.length
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Tokens the tool catalogue occupies in every request.
 *
 * The catalogue is assembled separately from the message array and never
 * entered the estimate, so a 30-tool registry — easily 10-20k tokens of
 * JSON Schema — was invisible to the trigger. It is also the most stable
 * part of the prompt, which is exactly why forgetting it biases every
 * reading the same way rather than averaging out.
 */
function estimateToolCatalogTokens(ctx: IterationContext): number {
	try {
		const tools = ctx.tools.toLLMTools(ctx.allowedTools)
		if (tools.length === 0) return 0
		return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN)
	} catch {
		// The catalogue is an optimisation of the estimate, not a
		// precondition for compacting. A registry that cannot render is a
		// problem for the model call, which will report it far better than
		// a crash inside the trigger would.
		return 0
	}
}

function estimateTokens(ctx: IterationContext): number {
	return estimateMessageTokens(ctx.runMgr.messages) + estimateToolCatalogTokens(ctx)
}

type ToolResultClearPlan = Extract<CompactionPlan, { kind: 'cleared' }>

/** Replace the contents while preserving the live array identity. */
function installMessages(live: Message[], next: readonly Message[]): void {
	live.length = 0
	for (const message of next) live.push(message)
}

/**
 * Publish a status snapshot for a context edit that has already committed.
 *
 * Cumulative usage and cost do not fall when history is shed. The context
 * does, and until the next provider response there is no more authoritative
 * number than the post-edit estimate. Emitting the existing state event at
 * this boundary lets hosts update immediately without inventing a second
 * accounting channel.
 */
async function emitContextUsageSnapshot(
	ctx: IterationContext,
	contextTokens: number,
	contextWindowTokens: number,
	windowSource: 'config' | 'provider' | 'model-table' | 'default',
): Promise<void> {
	await ctx.emitEvent?.({
		type: 'token_usage_updated',
		runId: ctx.runMgr.id,
		usage: { ...ctx.runMgr.tokenUsage },
		cost: { ...ctx.runMgr.costInfo },
		contextTokens,
		contextMeasuredBy: 'estimate',
		contextWindowTokens,
		windowSource,
	})
}

async function emitToolResultClear(
	ctx: IterationContext,
	plan: ToolResultClearPlan,
): Promise<void> {
	ctx.log.info('Cleared stale tool results instead of compacting', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.cleared': plan.clearedCount,
		'namzu.runtime.chars_reclaimed': plan.charsReclaimed,
		'namzu.runtime.reclaimed_tokens': plan.reclaimedTokens,
	})

	await ctx.emitEvent?.({
		type: 'compaction_tool_results_cleared',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		clearedCount: plan.clearedCount,
		...(plan.stubbedCount !== undefined ? { stubbedCount: plan.stubbedCount } : {}),
		charsReclaimed: plan.charsReclaimed,
		reclaimedTokens: plan.reclaimedTokens,
		reliefWasEnough: plan.reliefWasEnough,
	})
}

/** Install a clear-only pass and publish the state it established. */
async function commitToolResultClear(
	ctx: IterationContext,
	plan: ToolResultClearPlan,
	contextWindowTokens: number,
	windowSource: 'config' | 'provider' | 'model-table' | 'default',
): Promise<void> {
	installMessages(ctx.runMgr.messages, plan.messages)
	// The provider counted the pre-edit prompt. Leaving that measurement live
	// makes the next trigger compare the old prompt against the new history.
	ctx.runMgr.clearLastPromptTokens?.()
	await emitToolResultClear(ctx, plan)
	await emitContextUsageSnapshot(ctx, estimateTokens(ctx), contextWindowTokens, windowSource)
}

/**
 * How full the context is, in tokens.
 *
 * Prefer the provider's own count of the last prompt — it is a measurement,
 * not a guess, and it includes everything the heuristic cannot see (tool
 * schemas, system blocks, image tokens, per-message framing). The chars/4
 * estimate remains the fallback for iteration 1, before any turn has
 * reported, and for providers that do not return usage.
 *
 * The measurement describes the prompt as it was SENT, so everything the
 * turn appended afterwards — the assistant message and every one of its
 * tool results — falls outside it. Reading it verbatim therefore reported
 * a context one full turn stale, and staleness is largest on precisely the
 * turns that add the most: a turn that returns 200 KB of tool output was
 * counted as if it had returned nothing. That error and the missing tool
 * catalogue both point the same way — under-count — so the trigger did not
 * jitter around the threshold, it sat systematically late. The tail is
 * estimated rather than measured because no provider in the repo exposes a
 * token-count call; an approximate tail beats a certain omission.
 */
/**
 * How large the context being sent is right now, and whether that number was
 * counted or estimated.
 *
 * Exported because it is the only honest answer to "how much room is left",
 * and the surfaces that ask are outside this file. It was internal, so a host
 * wanting the figure had to derive one — and a host did, from cumulative run
 * spend divided by a window guessed from a model name, which is neither term
 * of the right fraction.
 */
export function measureContext(ctx: IterationContext): {
	tokens: number
	source: 'provider' | 'estimate'
} {
	const reported = ctx.runMgr.lastPromptTokens
	if (reported !== undefined && reported > 0) {
		const measuredThrough = ctx.runMgr.lastPromptMessageCount ?? ctx.runMgr.messages.length
		const appended = ctx.runMgr.messages.slice(measuredThrough)
		return { tokens: reported + estimateMessageTokens(appended), source: 'provider' }
	}
	return { tokens: estimateTokens(ctx), source: 'estimate' }
}

/**
 * Shed history because the PROVIDER said the prompt is too long.
 *
 * The threshold path guesses when to compact and can guess low — the
 * estimate is a heuristic, and a run carrying images or a language the
 * chars-per-token ratio does not fit will hit the real window while still
 * reading as comfortable. When that happens the provider tells us exactly
 * what is wrong, and the kernel already classifies it precisely and then
 * did nothing with it: the call was correctly marked non-retryable
 * (resending the identical prompt cannot help) and the run died holding a
 * compaction subsystem that could have made room.
 *
 * Forced rather than threshold-gated, because the threshold is the thing
 * that was just proven wrong.
 *
 * @returns whether anything was actually shed. `false` means retrying would
 *   send the same prompt again, so the caller must not.
 */
export async function relieveOverflow(ctx: IterationContext): Promise<boolean> {
	const before = ctx.runMgr.messages.length
	const beforeChars = totalChars(ctx.runMgr.messages)

	await runCompactionCheck(ctx, { force: true })

	const shed = beforeChars - totalChars(ctx.runMgr.messages)
	// A shed has to be big enough to plausibly change the provider's verdict.
	// Any positive number used to count, so clearing a single short tool
	// result reported success, the turn was retried against a prompt that was
	// still over the window, and the retry burned a call to learn nothing.
	// The floor is a fraction of what was there rather than a constant: what
	// counts as meaningful scales with the prompt.
	const meaningful = Math.max(MIN_RELIEF_CHARS, beforeChars * MIN_RELIEF_FRACTION)
	if (shed < meaningful) {
		ctx.log.warn('Context overflow with too little left to shed — the prompt is irreducible', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.messages': before,
			'namzu.runtime.chars_shed': shed,
			'namzu.runtime.needed_at_least': Math.ceil(meaningful),
		})
		return false
	}

	ctx.log.info('Relieved a context overflow by compacting', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.messages_before': before,
		'namzu.runtime.messages_after': ctx.runMgr.messages.length,
		'namzu.runtime.chars_shed': shed,
	})
	return true
}

function totalChars(messages: readonly { content: unknown }[]): number {
	let total = 0
	for (const msg of messages) total += measureContentChars(msg.content)
	return total
}

/**
 * Run a reducer and install what it returns, or leave the history alone.
 *
 * Three ways to decline, all of them ending the same way — the run keeps its
 * full history. `undefined` is the reducer saying so; a throw is treated as
 * the same answer, because a broken reduction hook should not kill a healthy
 * run any more than a broken `prepareStep` should; and a result that splits a
 * tool pair is REFUSED rather than repaired.
 *
 * That last one is the least obvious and the most important. `tool_result`
 * without its `tool_use` is a provider 400 on the next turn, so quietly
 * repairing it would trade a clear "this reducer split a tool pair" for an
 * opaque rejection a call later, with the reducer never implicated. The
 * invariant is written on {@link ContextReducer}; enforcing it where it is
 * violated is what makes it true rather than aspirational — and, below, it
 * is registered as `compaction:no-split-tool-pair` on the shared invariant
 * registry, so an operator can ask whether this build still holds it and
 * how many times it has not.
 */
/**
 * Put a compaction that shed nothing on the wire.
 *
 * All three decline paths reached a log line and stopped there. Every
 * command-line entry point silences the logger, so the outcome was invisible
 * to the user, to the host and to the model at once — and the run carried on
 * at full context toward a provider rejection several turns later that named
 * none of this. A shed that did not happen is as consequential as one that
 * did, and only one of them was observable.
 *
 * The history is untouched on every path, so this reports rather than repairs.
 */
async function declined(
	ctx: IterationContext,
	cause: 'reducer_threw' | 'shed_nothing' | 'split_tool_pair',
	messages: number,
	error?: string,
): Promise<void> {
	await ctx.emitEvent?.({
		type: 'compaction_failed',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		cause,
		messages,
		...(error !== undefined ? { error } : {}),
	})
}

/**
 * Ctx for `compaction:no-split-tool-pair`, registered just below: the
 * candidate history a reducer just returned, not yet installed. Passed on
 * every live call, in `applyReducer`; `namzu doctor` calls the same check
 * with no ctx at all and reads `unknown` back, because there is no
 * candidate reduction to ask about outside a live compaction pass.
 */
interface ToolPairInvariantContext {
	readonly messages: readonly Message[]
}

/**
 * `compaction:no-split-tool-pair` — the same {@link findDanglingMessages}
 * call the inline `if` used to make, registered so `namzu doctor` can list
 * it and a violation counts somewhere an operator can read. The check
 * itself, and the decision `applyReducer` makes with its answer, are
 * unchanged.
 */
invariants.register<ToolPairInvariantContext | undefined>(
	'compaction',
	'no-split-tool-pair',
	(ctx) => {
		if (!ctx) {
			return {
				state: 'unknown',
				reason: 'no candidate reduction to check outside a live compaction pass',
			}
		}
		return findDanglingMessages([...ctx.messages]).isValid
			? { state: 'holds' }
			: {
					state: 'violated',
					detail: 'reducer output splits a tool_use/tool_result pair across the cut',
				}
	},
)

async function applyReducer(
	ctx: IterationContext,
	reducer: ContextReducer,
	reduction: ContextReduction,
	measurement: {
		measuredBy: 'provider' | 'estimate'
		windowSource: 'config' | 'provider' | 'model-table' | 'default'
	},
): Promise<void> {
	const messages = ctx.runMgr.messages
	const before = messages.length
	const beforeChars = totalChars(messages)

	let next: readonly Message[] | undefined
	try {
		next = await reducer(reduction)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		ctx.log.warn('Context reducer threw — keeping the full history', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.reason': reduction.reason,
			'exception.message': message,
		})
		await declined(ctx, 'reducer_threw', before, message)
		return
	}

	if (!next || next.length >= before) {
		ctx.log.debug('Context reducer shed nothing', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.reason': reduction.reason,
			'namzu.runtime.messages': before,
		})
		await declined(ctx, 'shed_nothing', before)
		return
	}

	const toolPairOutcome = await invariants.evaluate('compaction:no-split-tool-pair', {
		messages: next,
	})
	if (toolPairOutcome.state === 'violated') {
		ctx.log.warn('Context reducer split a tool pair — refusing its result', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.reason': reduction.reason,
			'namzu.runtime.hint':
				'use findSafeTrimIndex to move a cut off a tool_use/tool_result boundary',
			'namzu.runtime.detail': toolPairOutcome.detail,
		})
		await declined(ctx, 'split_tool_pair', before)
		return
	}

	await recordShed(ctx, [...messages], next, reduction.reason)

	installMessages(messages, next)

	// The provider's count described the pre-reduction prompt. Same reasoning
	// as the structured path: leaving it would have the next trigger check
	// compare an old size against the new history and reduce again.
	ctx.runMgr.clearLastPromptTokens?.()

	ctx.log.info('Context reduced', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.reason': reduction.reason,
		'namzu.runtime.old_message_count': before,
		'namzu.runtime.new_message_count': messages.length,
		'namzu.runtime.chars_shed': beforeChars - totalChars(messages),
	})

	// This path emitted NOTHING on success, and it is the path a host-supplied
	// reducer and `strategy: 'sliding-window'` both take. So the event whose own
	// docstring says it exists because "a host could not show the user that
	// context was dropped" was never reaching the hosts most likely to need it —
	// the same mechanism-exists-and-one-site-does-not-use-it shape as the
	// silence on the decline paths above, in the opposite direction.
	//
	// Found by a test written for the decline paths asserting that success does
	// NOT report a failure, which is the only reason anybody looked here.
	const tokensAfter = estimateTokens(ctx)
	await ctx.emitEvent?.({
		type: 'compaction_completed',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		messagesBefore: before,
		messagesAfter: messages.length,
		tokensBefore: reduction.estimatedTokens,
		tokensAfter,
		measuredBy: measurement.measuredBy,
		contextWindowTokens: reduction.contextWindowTokens,
		windowSource: measurement.windowSource,
	})
	await emitContextUsageSnapshot(
		ctx,
		tokensAfter,
		reduction.contextWindowTokens,
		measurement.windowSource,
	)
}

/**
 * Record what a pass is about to remove, before it removes it.
 *
 * The ordering is the whole mechanism. `transcript.jsonl` is append-only
 * and `emitEvent` reaches it synchronously with the pass, while `persist()`
 * overwrites `messages.json` wholesale later in the loop — so emitting HERE
 * makes the record durable before the deletion is. Emitted after the array
 * install, a crash between the two loses exactly what this exists to keep.
 *
 * Diffed by identity, not by index. Both shed paths can retain messages
 * from the middle of the history — the structured one keeps whatever the
 * working-memory pass re-pinned — so "everything before the cut" would
 * record messages that are still there.
 */
async function recordShed(
	ctx: IterationContext,
	before: readonly Message[],
	after: readonly Message[],
	reason: 'threshold' | 'overflow',
): Promise<void> {
	if (ctx.compactionConfig?.recordShedHistory === false) return

	const kept = new Set<Message>(after)
	const shed = before.filter((m) => !kept.has(m))
	// Nothing shed, nothing to record. A pass that only rewrote the floor
	// emits no event rather than an empty one nobody can distinguish from a
	// real record of nothing.
	if (shed.length === 0) return

	await ctx.emitEvent?.({
		type: 'compaction_shed',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		messages: shed,
		reason,
	})
}

export async function runCompactionCheck(
	ctx: IterationContext,
	options?: { force?: boolean },
): Promise<void> {
	const config = ctx.compactionConfig
	if (!config) return
	if (config.strategy === 'disabled') return

	const measured = measureContext(ctx)
	const estimatedTokens = measured.tokens

	// The divisor is a WINDOW, never `runConfig.tokenBudget`. The old
	// fallback compared a live context size against a cumulative spend cap
	// — dimensionally the wrong quantity, and self-defeating: the guard
	// force-finalizes at 0.9 x tokenBudget while this needs 0.7 x the same
	// number. Nothing in the estate ever set `contextWindowTokens`, so the
	// fallback WAS the behavior, and the shipped CLI's 1M budget put the
	// trigger at ~700k. See `compaction/context-window.ts`.
	const window = resolveContextWindow(
		config.contextWindowTokens,
		ctx.runConfig.model,
		ctx.providerContextWindow,
	)
	const budget = window.tokens

	const usage = estimatedTokens / budget

	// A forced pass skips the threshold: it runs because the provider
	// rejected the prompt, which is stronger evidence than any estimate.
	// The salience strategy starts holding the context at `softTarget`,
	// well before the summary trigger; every other strategy waits for it.
	const salience = config.strategy === 'salience'
	const startAt = salience
		? Math.min(config.softTarget ?? DEFAULT_SOFT_TARGET, config.triggerThreshold)
		: config.triggerThreshold
	if (!options?.force && usage < startAt) return

	// A reducer, when the run has one, OWNS reduction — the structured pass
	// below does not also run. `strategy: 'sliding-window'` resolves to the
	// built-in one; a host-supplied reducer outranks the strategy entirely,
	// because someone who wrote a reducer has said what they want more
	// specifically than an enum can.
	const reducer =
		ctx.contextReducer ??
		(config.strategy === 'sliding-window' ? createSlidingWindowReducer() : undefined)
	if (reducer) {
		await applyReducer(
			ctx,
			reducer,
			{
				messages: ctx.runMgr.messages,
				reason: options?.force ? 'overflow' : 'threshold',
				estimatedTokens,
				contextWindowTokens: budget,
				model: ctx.runConfig.model,
				keepRecentMessages: config.keepRecentMessages,
			},
			{ measuredBy: measured.source, windowSource: window.source },
		)
		return
	}

	const manager = ctx.workingStateManager
	if (!manager) return

	ctx.log.info('Compaction threshold reached — compacting context', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.context_tokens': estimatedTokens,
		'namzu.runtime.measured_by': measured.source,
		'namzu.runtime.window': budget,
		'namzu.runtime.window_source': window.source,
		'namzu.runtime.usage': Math.round(usage * 100),
		'namzu.runtime.trigger_threshold': config.triggerThreshold,
		'namzu.runtime.slot_count': manager.slotCount(),
	})

	// Try the cheap, NON-destructive reclaim first: clear the output of old,
	// large tool results in place. Compaction paraphrases the agent's own
	// reasoning away, which is a heavy price for a context problem usually
	// caused by something dumber — a few enormous tool outputs the agent
	// already read and moved past. Clearing those keeps every message
	// verbatim, and keeps `tool_use` ↔ `tool_result` pairing intact by
	// construction, because nothing moves.
	//
	// The decision is `planCompaction`'s; installing it is this file's. The
	// planner touches no `ctx` at all, which is what lets the boundary
	// arithmetic be tested without a run.
	if (salience) {
		let openTasks: string[] | undefined
		if (ctx.taskStore) {
			try {
				const tasks = await ctx.taskStore.list({ runId: ctx.runMgr.id })
				openTasks = tasks
					.filter((t) => t.status !== 'completed')
					.map((t) => t.description)
					.filter((d): d is string => typeof d === 'string' && d.length > 0)
			} catch {
				// The goal is measured without the plan items; a task store
				// that cannot answer must not stop the pass.
			}
		}
		const working = planSalienceWorkingSet({
			messages: ctx.runMgr.messages,
			config,
			contextWindowTokens: budget,
			estimatedTokens,
			...(openTasks ? { openTasks } : {}),
		})
		if (working.reclaimedTokens > 0) {
			await commitToolResultClear(ctx, working, budget, window.source)
		}
		// Under the trigger, the working set was the whole pass: the summary
		// path is for the trigger, not for the soft target.
		if (
			!options?.force &&
			(estimatedTokens - working.reclaimedTokens) / budget < config.triggerThreshold
		) {
			return
		}
	}
	const clearPlan = planCompaction({
		messages: ctx.runMgr.messages,
		config,
		contextWindowTokens: budget,
		estimatedTokens,
		...(options?.force ? { force: true } : {}),
	})

	if (clearPlan.kind === 'cleared') {
		// If that was enough, stop here and keep the history verbatim. The
		// measurement is an estimate either way; the provider's own count for
		// the NEXT turn will correct it, and an over-eager summarization is
		// far more costly than one late pass.
		if (clearPlan.reliefWasEnough) {
			await commitToolResultClear(ctx, clearPlan, budget, window.source)
			return
		}
	}

	// Second call, over the cleared CANDIDATE when there is one. An
	// insufficient clear stays off the live Run until summary verification
	// succeeds. If that side call stalls, fails or is cancelled, the run keeps
	// one coherent pre-edit history instead of publishing half a pass.
	const stagedClear = clearPlan.kind === 'cleared' ? clearPlan : undefined
	const messages = stagedClear?.messages ?? ctx.runMgr.messages
	const plan = planCompaction({
		messages,
		config,
		contextWindowTokens: budget,
		estimatedTokens,
		skipToolResultClear: true,
		...(options?.force ? { force: true } : {}),
	})

	if (plan.kind !== 'plan') {
		// One log line per reason, with the fields each one was already
		// reporting. The planner names the reason; what it means to an
		// operator reading a run is this file's to say.
		if (plan.kind === 'skip') {
			switch (plan.reason) {
				case 'too_few_messages':
					ctx.log.debug('Not enough messages to compact', {
						'namzu.runtime.message_count': messages.length,
						'namzu.runtime.keep_recent_messages': config.keepRecentMessages,
					})
					break
				case 'no_safe_cut':
					ctx.log.debug('Skipping compaction — no safe cut at or below the naive boundary', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
						'namzu.runtime.system_messages': messages.filter((m) => m.role === 'system').length,
						'namzu.runtime.message_count': messages.length,
					})
					break
				case 'too_few_older':
					ctx.log.debug('Skipping compaction — too few older messages', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
					})
					break
				case 'no_system_floor':
					break
			}
		}
		// Clearing may have been useful even though no safe summary cut exists.
		// There is no opaque provider wait on this path, so publish that single
		// complete edit now rather than discarding it.
		if (stagedClear) {
			await commitToolResultClear(ctx, stagedClear, budget, window.source)
		}
		return
	}

	const { systemMessages, olderMessages, recentMessages, keepStart } = plan

	let compactedContent: string

	if (config.llmVerification && manager.slotCount() < config.richStateThreshold) {
		// Named once and used twice on purpose. The model the summariser is
		// asked for is also the model its tokens are priced at, and computing
		// the two separately is how they drift — a router that sends compaction
		// to a cheap model while the bill is written against the expensive one
		// is a mistake with no symptom.
		const compactionModel = resolveTaskModel('compaction', ctx.taskRouter, ctx.runConfig.model)
		compactedContent = await buildVerifiedSummaryWithBoundedProvider(
			manager,
			olderMessages as Message[],
			ctx.provider,
			config,
			(usage) =>
				ctx.runMgr.accumulateUsage(usage, {
					providerId: ctx.runMgr.servingProviderId,
					model: compactionModel,
				}),
			// The one model call a run makes that the user never asked for. It
			// reads a transcript and writes a summary, which is the cheapest
			// thing a small model does well, and it fires on exactly the long
			// runs where the primary model is most expensive. `taskRouter` had
			// been accepted, validated and threaded through four types since it
			// was added, and nothing ever consulted it.
			compactionModel,
			ctx.abortController.signal,
		)
	} else {
		compactedContent = serializeState(manager.getState())
	}

	const compactionMessage = buildCompactionMessage(compactedContent)

	// Drop a replaceable PRIOR `[COMPACTED CONTEXT]` summary from this run's
	// leading floor — `serializeState` is cumulative, so the new summary
	// supersedes it. A retained summary came from outside this manager's state
	// horizon (for example a host-triggered pass between runs) and remains
	// opaque; deleting it would erase the only surviving record of that span.
	const preservedSystem = systemMessages.filter(
		(m) =>
			!isCompactionMessage(typeof m.content === 'string' ? m.content : null) || m.retain === true,
	)

	// Pinned turns from the older window survive verbatim, in order, between
	// the summary and the recent window. They are also described by the
	// summary, which is the point rather than a waste: a paraphrase is what
	// the pin exists to refuse.
	const retained = findRetainedIndices(messages)
	const retainedOlder =
		retained.size === 0
			? []
			: messages
					.slice(systemMessages.length, keepStart)
					.filter((_, offset) => retained.has(systemMessages.length + offset))

	const newMessages = [...preservedSystem, compactionMessage, ...retainedOlder, ...recentMessages]

	// OPAQUE survival guard (ses_055 D1): the pinned working-memory slot is a
	// leading system message, so it is kept in `preservedSystem` (the compaction
	// filter only drops prior `[COMPACTED CONTEXT]` summaries, never the WM slot)
	// and survives for free — this branch is DEFENSIVE-ONLY, exercised only if a
	// future change drops the slot from the rebuilt set. It re-pins the block
	// already present in `messages` (the one `refreshWorkingMemory` placed).
	// Identity is the sentinel HEADER only — no path parsing, no second provider
	// call, no host format knowledge in the SDK.
	const survives = newMessages.some((m) => m.role === 'system' && isWorkingMemoryMessage(m.content))
	if (!survives) {
		const priorSlot = messages.find((m) => m.role === 'system' && isWorkingMemoryMessage(m.content))
		if (priorSlot) {
			// Re-pin as the last leading system message, before the summary.
			newMessages.splice(preservedSystem.length, 0, priorSlot)
			ctx.log.warn('Re-pinned working-memory slot dropped by compaction', {
				[NAMZU.RUN_ID]: ctx.runMgr.id,
			})
		}
	}

	const live = ctx.runMgr.messages
	const oldCount = live.length
	await recordShed(ctx, [...live], newMessages, options?.force ? 'overflow' : 'threshold')

	installMessages(live, newMessages)

	const newEstimate = estimateTokens(ctx)

	// The provider's count described the PRE-compaction prompt; the window
	// it just shrank to has not been sent yet, so the post number is
	// necessarily an estimate. Invalidate the stale reading so the next
	// trigger check does not compare the old prompt size against the new
	// context and compact again immediately.
	ctx.runMgr.clearLastPromptTokens?.()
	// The clear and the summary were one staged state transition. Publish the
	// clear first for chronological audit semantics, but only now that both
	// edits are installed and no verifier can still fail between them.
	if (stagedClear) await emitToolResultClear(ctx, stagedClear)

	// Hysteresis. A pass that only gets the context from 0.72 to 0.71 of the
	// window leaves the trigger armed, so the next iteration compacts again
	// — paying a summarization call and busting the prompt-cache prefix each
	// time, for nothing. Report the shortfall rather than repeating a move
	// that demonstrably does not work; `resetThreshold` was declared and
	// CLI-set but read by nothing until now.
	const reachedReset = newEstimate / budget <= config.resetThreshold
	if (!reachedReset) {
		ctx.log.warn('Compaction did not reach its reset threshold — context may still be tight', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.after_usage': Math.round((newEstimate / budget) * 100),
			'namzu.runtime.reset_threshold': Math.round(config.resetThreshold * 100),
			'namzu.runtime.hint':
				'lower keepRecentMessages, or raise the context window if the model supports one',
		})
	}

	ctx.log.info('Context compacted', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.old_message_count': oldCount,
		'namzu.runtime.new_message_count': live.length,
		'namzu.runtime.removed_messages': oldCount - live.length,
		'namzu.runtime.old_token_estimate': estimatedTokens,
		'namzu.runtime.new_token_estimate': newEstimate,
		'namzu.runtime.reduction_percent': Math.round((1 - newEstimate / estimatedTokens) * 100),
		'namzu.runtime.reached_reset': reachedReset,
		'namzu.runtime.slot_count': manager.slotCount(),
	})

	// Compaction is destructive and was, until now, completely silent: no
	// event, no transcript record, nothing a host could surface. Emit the
	// loss so it is observable.
	await ctx.emitEvent?.({
		type: 'compaction_completed',
		runId: ctx.runMgr.id,
		iteration: ctx.runMgr.currentIteration,
		messagesBefore: oldCount,
		messagesAfter: live.length,
		tokensBefore: estimatedTokens,
		tokensAfter: newEstimate,
		measuredBy: measured.source,
		contextWindowTokens: budget,
		windowSource: window.source,
		reachedResetThreshold: reachedReset,
	})
	await emitContextUsageSnapshot(ctx, newEstimate, budget, window.source)
}
