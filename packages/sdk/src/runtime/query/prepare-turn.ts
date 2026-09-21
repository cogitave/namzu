import { drainQueuedMessages } from '../../agents/handle.js'
import {
	type ToolHistoryRepairReport,
	repairToolMessageHistory,
	toolHistoryRepairChanged,
} from '../../compaction/dangling.js'
import { type RecordedMessage, readFoldedHistory } from '../../manager/session/turn-recorder.js'
import { resolveModelPricing } from '../../pricing/index.js'
import { isCallerAbortError } from '../../provider/errors.js'
import {
	type ProviderChainMember,
	type ServingMember,
	withProviderFallback,
} from '../../provider/fallback.js'
import { resolveStreamIdleTimeoutMs, withStreamIdleTimeout } from '../../provider/idle-timeout.js'
import { withProviderRetry } from '../../provider/retry.js'
import { withTokenBudget } from '../../provider/token-budget.js'
import { resolveAttachments } from '../../store/attachment/index.js'
import type { SessionTokenBudget } from '../../store/budget/index.js'
import { NAMZU } from '../../telemetry/attributes.js'
import type { SerializedSpanContext } from '../../telemetry/attributes.js'
import type { TaskScheduler } from '../../types/agent/scheduler.js'
import { NamzuError } from '../../types/errors/index.js'
import { autoApproveHandler } from '../../types/hitl/index.js'
import type { SessionApprovalPolicy } from '../../types/hitl/policy.js'
import type { CheckpointId, MessageId, PlanId, TurnId } from '../../types/ids/index.js'
import type { Message, UserMessage } from '../../types/message/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import { cancelCauseOf } from '../../types/session/cancel-cause.js'
import type { TurnConfig } from '../../types/session/index.js'
import type { TurnState } from '../../types/session/turn-state.js'
import { TurnInProgressError } from '../../types/session/turn.js'
import type { ModelPricing } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateCheckpointId, generateTurnId } from '../../utils/id.js'
import { errorAttributes } from '../../utils/log/exception.js'
import type { Logger } from '../../utils/logger.js'
import { AUTO_APPROVE_POLICY_NAME, createSessionApprovalPolicy } from './approval-policy.js'
import { type TurnContext, TurnContextFactory } from './context.js'
import { EventTranslator } from './events.js'
import type { QueryParams } from './index.js'
import { isCompactionMessage } from './iteration/phases/compaction.js'
import { isWorkingMemoryMessage } from './iteration/phases/working-memory.js'
import {
	awaitProjectInstructionCallback,
	collapseProjectInstructionSnapshots,
	replaceProjectInstructionSnapshot,
} from './project-instructions.js'
import type { PromptCache } from './prompt-cache.js'
import { resolveMaxRequestRichContentBytes } from './request-rich-content.js'
import { resolveSandboxTeardownTimeoutMs } from './sandbox-lifecycle.js'
import { type SessionStorage, resolveSessionStorage } from './session-storage.js'
import { type SavedBudgetReference, resolveQueryBudget } from './token-budget.js'
import { assertMaxToolCalls } from './tool-call-budget.js'

/**
 * Everything `query()` needs from its prelude, handed over as one value.
 *
 * The prelude is where the turn is DECIDED — what it refuses, which provider
 * chain serves it, which history it starts from — and it is deliberately
 * separated from the turn that then executes, because the two answer different
 * questions and only the second one streams. Nothing here is a bag of mutable
 * state passed back in: each field is a value the prelude produced and the
 * body reads afterwards.
 */
export interface PreparedTurn {
	readonly turnConfig: TurnConfig
	readonly budget: SessionTokenBudget
	/** Where the session's log, checkpoints and ledger live. */
	readonly storage: SessionStorage
	readonly log: Logger
	readonly ctx: TurnContext
	readonly resilientProvider: LLMProvider
	readonly serving: { current: ServingMember }
	readonly providerContextWindow: number | undefined
	readonly modelContextWindows: Map<string, number | undefined>
	readonly approvalPolicy: SessionApprovalPolicy
	readonly eventTranslator: EventTranslator
	readonly executeUserInterruptHooks: (terminalError: unknown) => Promise<void>
	/**
	 * Repair reports this turn owes its log.
	 *
	 * Created here and KEPT: the turn's resume path pushes one more as it
	 * restores a checkpoint, and the turn emits the whole list once it is
	 * writable. The array identity is part of the contract, not an accident of
	 * the return value being an object.
	 */
	readonly pendingHistoryRepairs: PendingHistoryRepairEvent[]
	readonly initialMessages: Message[]
	/**
	 * The ids of the messages in {@link initialMessages} that the session log
	 * already holds (its folded history); every other initial message is new
	 * and is recorded when the turn begins.
	 */
	readonly historyIds: ReadonlyMap<Message, MessageId>
	readonly queuedForThisRun: readonly Message[]
	readonly selectedResumeState: SelectedResumeState | undefined
	readonly attachmentResolutionCancelled: boolean
	readonly streamIdleTimeoutMs: number
	readonly sandboxTeardownTimeoutMs: number
	readonly promptCache: PromptCache | undefined
	readonly taskScheduler: TaskScheduler | undefined
}

export type SelectedResumeState = TurnState & {
	readonly checkpointId: CheckpointId
	readonly traceContext?: SerializedSpanContext
	/** Record ids of `messages` (the fold through the checkpoint), by message. */
	readonly messageIds?: ReadonlyMap<Message, MessageId>
}
export const selectedResumeStates = new WeakMap<QueryParams, SelectedResumeState>()

/**
 * Refuse to price a turn whose tokens two differently-priced members may produce.
 *
 * `TurnRecorder` holds ONE {@link ModelPricing} table and applies it to every
 * accumulation regardless of which model produced the tokens. Across a swap that
 * makes `costInfo.totalCost` wrong by an unbounded margin, and silently — the
 * number keeps the shape of an answer. `CostInfo` cannot express the truth
 * either: it carries `inputCostPer1M` / `outputCostPer1M`, and there is no
 * honest value for those once a total spans two rate cards.
 *
 * So the total is refused rather than blended. Naming what that costs is part
 * of the refusal, because the caller loses `costLimitUsd` with it: the guard
 * enforces that limit from this same accumulated total, and a limit enforced
 * with the wrong rate card stops a turn early or late by the same unbounded
 * margin. A budget that is quietly wrong is worse than a budget that is
 * declined.
 *
 * Reachable, not decorative: a host that passes `pricing` and declares a chain
 * hits it on the first call. It costs `@namzu/cli` nothing, which passes no
 * pricing at all — its `/cost` already reports that the provider gave no price.
 *
 * The way out is per-member pricing, which needs a `CostInfo` that can sum over
 * heterogeneous rates. That is a public-type change and it is not this one.
 */
function assertCostIsAttributable(
	chain: readonly ProviderChainMember[],
	pricing: ModelPricing | undefined,
): void {
	if (pricing === undefined || chain.length < 2) return
	throw new NamzuError({
		code: 'invalid_config',
		message:
			`A provider chain of ${chain.length} members was declared together with a single pricing table. ` +
			'One table cannot price two members, so the turn would report a total that is wrong by an unbounded ' +
			'margin — and `turnConfig.costLimitUsd` would be enforced against that same wrong total. ' +
			'Either drop `pricing` (usage is still reported per model in the turn) or declare one member.',
		details: { chainLength: chain.length },
	})
}

/**
 * Refuse a budget that cannot be measured.
 *
 * `turnConfig.costLimitUsd` is enforced against `costInfo.totalCost`, and that
 * total only moves for tokens something has a rate for. A model no rate card
 * covers therefore produced a limit that could never trip — a host that set a
 * cost cap had no cost cap, and nothing said so. That was every turn before the
 * price catalogue existed, which is how it went unnoticed.
 *
 * Refusing at the front is the cheap half of the answer: it costs the caller
 * nothing, fires before any spend, and names both ways out. The other half is
 * the `cost_unmeasurable` stop, for the models this cannot see — a step naming
 * its own, or a chain member declaring one.
 *
 * This is the same shape `advisory/budget.ts` already applies to
 * `AdvisoryBudget.maxCostPerTurn`, one layer down, and for the same reason. The
 * run path simply never had it.
 */
function assertBudgetIsMeasurable(params: QueryParams): void {
	const limit = params.turnConfig.costLimitUsd
	if (limit === undefined || limit <= 0) return
	// A host-supplied table prices whatever it is pointed at, so a caller who
	// brought one has answered the question themselves.
	if (params.pricing !== undefined) return
	const model = params.turnConfig.model
	if (resolveModelPricing(params.provider.id, model) !== undefined) return

	throw new NamzuError({
		code: 'invalid_config',
		message:
			`turnConfig.costLimitUsd is set to ${limit}, but no rate is known for model "${model}" on ` +
			`provider "${params.provider.id}". The limit is enforced against the turn's accumulated ` +
			'cost, and tokens with no rate never reach that total — so the budget would read as ' +
			'satisfied for the whole turn and stop nothing. Either pass `pricing` to declare the rate ' +
			'yourself, add the model to packages/sdk/src/pricing/rates.source.json, or drop ' +
			'`costLimitUsd` and bound the turn with `tokenBudget`, which is measurable here.',
		details: { model, providerId: params.provider.id, costLimitUsd: limit },
	})
}

/**
 * Ask the driver what this model's window is, and never let the answer
 * cost the turn.
 *
 * Three outcomes collapse to two here on purpose. No member and a resolved
 * `undefined` both mean "no answer" — the distinction matters to a driver
 * author, not to a caller about to fall through to the table. A rejection
 * is the third, and it is logged rather than propagated: a turn that would
 * have worked on the table must not fail because a listing endpoint was
 * down.
 */
export async function resolveProviderContextWindow(
	provider: LLMProvider,
	model: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	log: Logger,
): Promise<number | undefined> {
	if (!provider.resolveContextWindow || !model) return undefined
	if (signal?.aborted) return undefined

	// The resolver is an optional optimisation that runs before TurnContext
	// owns its child controller. Give it a private deadline signal and fuse
	// caller cancellation into that transport in the safe direction: neither
	// outcome aborts the caller's controller. Passing a signal is necessary
	// but not sufficient, because a third-party driver can accept it and still
	// leave its promise pending; the race below makes fallback independent of
	// driver cooperation. Promise.race keeps the losing provider promise
	// observed, so a later rejection cannot become unhandled.
	const deadline = new AbortController()
	const resolverSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
	const interrupted = Symbol('provider-context-window-interrupted')
	let onAbort: (() => void) | undefined
	const interruption = new Promise<typeof interrupted>((resolve) => {
		onAbort = () => resolve(interrupted)
		resolverSignal.addEventListener('abort', onAbort, { once: true })
	})
	// Direct QueryParams callers can supply a large turn deadline. The clamp
	// avoids Node's >2^31-1 one-millisecond timer coercion during metadata lookup.
	// Metadata discovery remains optional and bounded even without a turn deadline.
	const deadlineMs = timeoutMs === 0 ? 5_000 : Math.min(Math.max(0, timeoutMs), 2_147_483_647)
	const timer = setTimeout(() => {
		deadline.abort(new Error(`Provider context-window lookup exceeded ${deadlineMs}ms`))
	}, deadlineMs)

	try {
		const resolution = provider.resolveContextWindow(model, resolverSignal)
		const reported = await Promise.race([resolution, interruption])
		if (reported === interrupted) {
			if (deadline.signal.aborted) {
				log.debug('Provider context-window lookup timed out; using the table', {
					'namzu.model.id': model,
					'namzu.runtime.timeout_ms': deadlineMs,
				})
			}
			return undefined
		}
		return typeof reported === 'number' && reported > 0 ? reported : undefined
	} catch (err) {
		log.debug('Provider could not report a context window; using the table', {
			'namzu.model.id': model,
			'namzu.error.message': toErrorMessage(err),
		})
		return undefined
	} finally {
		clearTimeout(timer)
		if (onAbort) resolverSignal.removeEventListener('abort', onAbort)
	}
}

export interface PendingHistoryRepairEvent {
	readonly source: 'fresh-history' | 'abandoned-checkpoint'
	readonly report: ToolHistoryRepairReport
}

/**
 * Project historical system messages exactly as a new turn will persist them.
 *
 * Arbitrary historical prompt floors are rebuilt for this turn and therefore
 * never reach its provider-bound conversation. Repair must happen AFTER that
 * removal: treating a soon-to-be-dropped system message as a tool-result
 * boundary can replace an exact real result with an invented unknown outcome.
 * The two state-bearing system forms survive; fresh inherited compaction is
 * pinned until this turn can prove it reconstructed equivalent state.
 */
export function projectStateBearingHistory(
	messages: readonly Message[],
	options: { readonly pinCompaction: boolean },
): Message[] {
	const projected: Message[] = []
	for (const message of messages) {
		if (message.role !== 'system') {
			projected.push(message)
			continue
		}
		if (isCompactionMessage(message.content)) {
			projected.push(options.pinCompaction ? { ...message, retain: true } : message)
		} else if (isWorkingMemoryMessage(message.content)) {
			projected.push(message)
		}
	}
	return collapseProjectInstructionSnapshots(projected)
}

export async function prepareTurn(params: QueryParams): Promise<PreparedTurn> {
	assertMaxToolCalls(params.maxToolCalls)
	// Required types do not protect JavaScript callers. Reject missing scope
	// before opening a budget or persisting a turn without its owning identity.
	const missingFields = (['sessionId', 'topicId', 'projectId', 'tenantId'] as const).filter(
		(field) => !params[field],
	)
	if (missingFields.length > 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `query requires sessionId, topicId, projectId, and tenantId; missing: ${missingFields.join(', ')}.`,
			details: { missingFields },
		})
	}
	const selectedResumeState = selectedResumeStates.get(params)
	selectedResumeStates.delete(params)
	// Resolved at the DOOR, before a turn id exists or a logger is built.
	// A caller who set both spellings of a renamed field has a config bug,
	// and refusing it here costs them nothing; refusing it at the read site
	// deep in the loop turns the same bug into a mid-run failure, after a
	// provider call has been paid for and a partial transcript written.
	const promptCache = params.promptCache
	const taskScheduler = params.taskScheduler
	const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(params.turnConfig.streamIdleTimeoutMs)
	const maxRequestRichContentBytes = resolveMaxRequestRichContentBytes(
		params.turnConfig.maxRequestRichContentBytes,
	)
	const sandboxTeardownTimeoutMs = resolveSandboxTeardownTimeoutMs(params.sandboxTeardownTimeoutMs)
	// Persist the EFFECTIVE value, not only an override. A turn replayed after a
	// later release must be able to explain which liveness policy settled it;
	// an absent field whose meaning follows the currently-installed default
	// would rewrite that evidence at read time.
	const turnConfig: TurnConfig = {
		...params.turnConfig,
		streamIdleTimeoutMs,
		maxRequestRichContentBytes,
	}

	// The turn's one correlated logger, built before anything below needs
	// one — the migration check, the retry/fallback wrappers and `ctx`
	// itself all read this SAME object, so a retry warning and the turn
	// record it retried for carry the identical `namzu.turn.id` instead of
	// three separate `getRootLogger()` reads that happened to agree by
	// accident. `turnId` is resolved here, once, rather than left to
	// `build`'s own `config.turnId ?? generateTurnId()` fallback —
	// generating it twice would silently hand the log and the turn two
	// different ids.
	const turnId = params.turnId ?? generateTurnId()
	if (params.resumeFromCheckpoint && !params.turnId) {
		throw new NamzuError({
			code: 'invalid_config',
			message:
				'resumeFromCheckpoint continues an existing turn and needs its turnId; a new turn cannot start from a checkpoint (fork a new session instead).',
			details: { resumeFromCheckpoint: params.resumeFromCheckpoint },
		})
	}
	const storage = await resolveSessionStorage({
		sessionId: params.sessionId,
		...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
		...(params.sessionLog ? { sessionLog: params.sessionLog } : {}),
		...(params.paths ? { paths: params.paths } : {}),
		...(params.checkpointStore ? { checkpointStore: params.checkpointStore } : {}),
		...(params.tokenBudgetStore ? { tokenBudgetStore: params.tokenBudgetStore } : {}),
		...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
	})
	const savedBudget = await savedBudgetReference(params, turnId, storage, selectedResumeState)
	const budget = await resolveQueryBudget(params, turnId, storage.tokenBudget, savedBudget)
	const log = TurnContextFactory.buildLogger({
		agentName: params.agentName,
		turnConfig,
		turnId,
		...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
		sessionId: params.sessionId,
		topicId: params.topicId,
		projectId: params.projectId,
		tenantId: params.tenantId,
	})

	// Every model call in the turn — the loop's turns, the forced-final
	// summary, advisory and compaction side calls — goes through this one
	// wrapped provider, so the retry policy cannot be bypassed by a code
	// path that happens to hold the raw driver.
	// The logger is passed on purpose: `withProviderRetry` guards every one
	// of its warns behind `options.log`, and this is its only production
	// call site — so without it the "failed, retrying" and "failed, giving
	// up" lines were dead code and a backoff left no trace anywhere.
	//
	// With a chain declared, the same sentence holds two levels out. The idle
	// watchdog is applied to each raw member, retry wraps that, and fallback
	// wraps the members: `fallback(retry(idle(m0)), retry(idle(m1)), …)`. The
	// idle layer cannot sit outside retry, because its timer would then count a
	// legitimate backoff as provider silence. This order is not a
	// preference. Assembled the other way round — which is what a host gets if
	// it wraps its own chain and hands the result in, because this function
	// would then wrap THAT in retry — an exhausted chain gets restarted from
	// the head by the outer loop and a throttle on the last member is counted
	// by two budgets. Building it here is what makes the order unspellable
	// wrong.
	const chain: readonly ProviderChainMember[] = [
		{ provider: params.provider },
		...(params.fallbackProviders ?? []),
	]
	assertCostIsAttributable(chain, params.pricing)
	assertBudgetIsMeasurable(params)
	const withRecovery = (provider: LLMProvider): LLMProvider => {
		const withIdleBound = withStreamIdleTimeout(provider, {
			idleTimeoutMs: streamIdleTimeoutMs,
			log,
		})
		const metered = withTokenBudget(withIdleBound, budget)
		return params.retry === false
			? metered
			: withProviderRetry(metered, {
					config: params.retry,
					log,
					canRetry: () => budget.remaining > 0,
				})
	}
	// Who is serving right now, for the turn RECORD rather than for the request.
	//
	// It starts at the head and moves only when the chain does, which is the
	// whole of the truth because the cursor never rewinds. The turn cannot read
	// this off `resilientProvider`: that wrapper reports the head's `id` on
	// purpose, so asking it produces the declaration back — the defect this
	// record exists to fix.
	const serving: { current: ServingMember } = {
		current: { index: 0, providerId: params.provider.id },
	}
	const resilientProvider = withProviderFallback(
		chain.map((member) => ({
			...member,
			provider: withRecovery(member.provider),
		})),
		{
			log,
			canFallback: () => budget.remaining > 0,
			onSwap: (to) => {
				serving.current = to
				// `ctx` is declared below and is initialized before anything can
				// call the provider: this fires from inside a `chatStream`, and
				// the first one is issued by the loop that `ctx` is built for.
				ctx.recorder.setServingProvider(to.providerId)
			},
		},
	)

	// Asked ONCE, here, before the loop exists. Both readers are synchronous
	// and hot, so this can never move inside the iteration — and a driver
	// that rejects, or one that hangs until the turn is cancelled, must not
	// take down a run the table could have served perfectly well. That is
	// why the failure path is a swallow with a log rather than a throw: the
	// window is an optimisation over a working default, not a prerequisite.
	const providerContextWindow = await resolveProviderContextWindow(
		resilientProvider,
		turnConfig.model,
		params.signal,
		turnConfig.timeoutMs,
		log,
	)
	const modelContextWindows = new Map<string, number | undefined>()
	if (turnConfig.model) modelContextWindows.set(turnConfig.model, providerContextWindow)

	// The mode this conversation was left in, when the turn config names none.
	// Read once, before the loop exists, for the same reason the context
	// window is: the executor's resolver is synchronous and hot.
	//
	// A store that throws is not a turn failure — the turn falls back to the
	// config's answer, which is exactly what it did before this existed.
	const topicState = params.topicStateStore
		? await params.topicStateStore
				.getState(params.topicId, params.tenantId)
				.catch((err: unknown) => {
					log.debug('Could not read the topic state; using the turn config', {
						'namzu.topic.id': params.topicId,
						'namzu.error.message': toErrorMessage(err),
					})
					return null
				})
		: null

	// Whatever a host left for "the next turn", taken and cleared in one
	// compare-and-set write. Prepended to the messages this turn starts from,
	// so it is in the FIRST request rather than arriving a turn late.
	//
	// Cleared as it is read: a queue read and cleared separately re-delivers
	// on a crash between the two, and "start with this" arriving twice is a
	// different instruction from the one that was left.
	const queuedForThisRun: readonly Message[] = params.topicStateStore
		? await drainQueuedMessages(params.topicStateStore, params.topicId, params.tenantId).catch(
				(err: unknown) => {
					log.debug('Could not drain the topic queue; starting without it', {
						'namzu.topic.id': params.topicId,
						'namzu.error.message': toErrorMessage(err),
					})
					return []
				},
			)
		: []

	// One effective list, used everywhere the turn is seeded from. Three
	// branches below push from it, and computing it at each would be three
	// places to forget the queue.
	//
	// Stored attachments are resolved HERE, once, before the messages reach
	// the turn record. Resolving later — at the provider boundary — would put
	// refs in the durable transcript and in every checkpoint, and a turn
	// resumed against a store that had since forgotten a ref would fail
	// replaying its own history rather than at the moment somebody asked for
	// the bytes. Every failure refuses: a message that silently lost its
	// image is a model answering about a picture it never saw.
	const ctx = TurnContextFactory.build({
		budget,
		...(topicState ? { topicPermissionMode: topicState.permissionMode } : {}),
		...(params.permissionModeRef ? { permissionModeRef: params.permissionModeRef } : {}),
		agentId: params.agentId,
		agentName: params.agentName,
		turnConfig,
		provider: resilientProvider,
		workingDirectory: params.workingDirectory,
		pricing: params.pricing,
		enableActivityTracking: params.enableActivityTracking,
		signal: params.signal,
		sessionId: params.sessionId,
		topicId: params.topicId,
		projectId: params.projectId,
		tenantId: params.tenantId,
		storage,
		turnId,
		...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
		...(params.parentTurnId ? { parentTurnId: params.parentTurnId } : {}),
		...(params.depth !== undefined ? { depth: params.depth } : {}),
		log,
	})

	// The writer lease, and `session_started` on an empty log. Everything
	// from here to the end of the turn holds the lease, so a failure before
	// the turn body owns it releases it.
	await ctx.recorder.open({
		...(params.lease ? { lease: params.lease } : {}),
		session: {
			cwd: ctx.cwd,
			...(params.origin ? { origin: params.origin } : {}),
			...(params.forkedFrom ? { forkedFrom: params.forkedFrom } : {}),
		},
	})
	try {
		await assertTurnMayStart(params, turnId, storage, ctx)
		// The session log is the conversation's source of truth. A new turn starts
		// from its folded history, and `params.messages` is what this turn adds.
		// A host that still passes the whole conversation is tolerated: the part
		// of it the log already holds is not added a second time.
		const history: RecordedMessage[] = params.resumeFromCheckpoint
			? []
			: await readFoldedHistory(storage.log)
		const input = withoutRecordedPrefix(params.messages, history)
		const seeded: Message[] = queuedForThisRun.length > 0 ? [...queuedForThisRun, ...input] : input
		let resolvedInitialMessages: Message[]
		let attachmentResolutionCancelled = false
		try {
			resolvedInitialMessages = [
				...(await resolveAttachments(seeded, params.attachmentStore, {
					signal: params.signal,
					timeoutMs: params.attachmentResolveTimeoutMs,
				})),
			]
			params.signal?.throwIfAborted()
		} catch (error) {
			// Attachment materialization precedes TurnContext construction so stored
			// bytes never enter a live turn's checkpoints. Cancellation still belongs
			// to that run: preserve the exact input refs, build the context below, and
			// let its normal terminal path classify/persist a cancelled turn. Every
			// other store failure remains a pre-run refusal.
			if (!params.signal?.aborted || error !== params.signal.reason) throw error
			resolvedInitialMessages = [...seeded]
			attachmentResolutionCancelled = true
		}
		if (
			!attachmentResolutionCancelled &&
			params.projectInstructionContext?.prepareInitialSnapshot
		) {
			const preparationSignal = params.signal ?? new AbortController().signal
			let snapshot: UserMessage | null | undefined
			try {
				const prepared = await awaitProjectInstructionCallback(preparationSignal, () =>
					params.projectInstructionContext?.prepareInitialSnapshot?.({
						messages: [...resolvedInitialMessages],
						signal: preparationSignal,
					}),
				)
				// The callback promise can settle, remove its listener, and queue this
				// continuation immediately before a queued abort. Publication is a
				// separate authority boundary, so fence it too.
				preparationSignal.throwIfAborted()
				snapshot = prepared
			} catch (error) {
				// This callback runs before TurnContext owns its child controller. A
				// caller cancellation here still belongs to the turn: publish no late
				// snapshot and let the context below settle the normal cancelled turn.
				// Compare the exact reason: a callback failure that won first must not
				// be erased merely because cancellation arrived before this catch ran.
				if (!preparationSignal.aborted || error !== preparationSignal.reason) throw error
			}
			if (snapshot !== undefined) {
				resolvedInitialMessages = replaceProjectInstructionSnapshot(
					resolvedInitialMessages,
					snapshot,
					'before-latest-user',
				)
			}
		}
		const pendingHistoryRepairs: PendingHistoryRepairEvent[] = []
		const historyIds = new Map<Message, MessageId>()
		const projectedHistory = params.continuationMode
			? history.map((entry) => {
					if (entry.messageId) historyIds.set(entry.message, entry.messageId)
					return entry.message
				})
			: projectRecordedHistory(history, historyIds)
		const projectedInitialMessages = collapseProjectInstructionSnapshots([
			...projectedHistory,
			...(params.resumeFromCheckpoint || params.continuationMode
				? resolvedInitialMessages
				: projectStateBearingHistory(resolvedInitialMessages, {
						pinCompaction: true,
					})),
		])
		const initialRepair = params.resumeFromCheckpoint
			? { messages: projectedInitialMessages, report: undefined }
			: repairToolMessageHistory(projectedInitialMessages)
		const initialMessages = initialRepair.messages
		if (initialRepair.report && toolHistoryRepairChanged(initialRepair.report)) {
			pendingHistoryRepairs.push({
				source: 'fresh-history',
				report: initialRepair.report,
			})
			log.warn('Repaired provider-invalid tool history before starting the turn', {
				[NAMZU.TURN_ID]: turnId,
				'namzu.history.source': 'fresh-history',
				'namzu.history.duplicate_tool_results_removed':
					initialRepair.report.duplicateToolResultsRemoved,
				'namzu.history.orphaned_tool_results_removed':
					initialRepair.report.orphanedToolResultsRemoved,
				'namzu.history.synthetic_tool_results_inserted':
					initialRepair.report.syntheticToolResultsInserted,
			})
		}

		// Built here because the plan-approval closure below captures it, and
		// its `emit` resolves `eventTranslator` at CALL time — the translator is
		// a `const` some lines further down.
		//
		// The HANDOUT is therefore deliberately NOT here. A host given the box
		// at this point can call `set` synchronously, `emit` reaches
		// `eventTranslator` inside its temporal dead zone, and the turn dies
		// before it starts. That is not hypothetical: it is what the first
		// version of this did, and the test that hands out the box and
		// immediately swaps the policy is the one that found it.
		const approvalPolicy = createSessionApprovalPolicy({
			turnId: ctx.turnId,
			initial: {
				// By identity against the default, not by presence. `resumeHandler`
				// is REQUIRED on `QueryParams` — `drainQuery` substitutes
				// `autoApproveHandler` before calling here — so "is it set" is
				// always yes and would name every turn `host`, including the ones
				// approving everything unattended. Identity is what actually
				// separates the two.
				name:
					params.approvalPolicyName ??
					(params.resumeHandler === autoApproveHandler ? AUTO_APPROVE_POLICY_NAME : 'host'),
				handler: params.resumeHandler,
			},
			emit: (event) => eventTranslator.emitEvent(event),
		})

		const planApprovalIds = new Map<PlanId, CheckpointId>()
		ctx.planManager.setApprovalHandler(async (request) => {
			let checkpointId = planApprovalIds.get(request.planId)
			if (!checkpointId) {
				checkpointId = generateCheckpointId()
				planApprovalIds.set(request.planId, checkpointId)
			}
			// `.current.handler`, never a captured `params.resumeHandler`. That
			// capture is what made changing the policy mean ending the turn.
			const decision = await approvalPolicy.current.handler({
				type: 'plan_approval',
				sessionId: ctx.sessionId,
				turnId: ctx.turnId,
				checkpointId,
				plan: {
					planId: request.planId,
					title: request.title,
					steps: request.steps.map((s, i) => ({
						id: s.id,
						description: s.description,
						toolName: s.toolName,
						agentId: s.agentId,
						dependsOn: s.dependsOn,
						order: s.order ?? i + 1,
					})),
					summary: request.summary,
				},
			})

			if (decision.action === 'approve_plan') {
				// Optional approve-with-edits channel: the host may attach
				// feedback to an approval. `PlanApprovalResponse.feedback`
				// already exists on the type; threading it through lets the
				// coordinator's approve_plan tool surface the user's edits in
				// the same tool_result that unblocks the park. Bare approvals
				// stay byte-identical (`{ approved: true }`).
				return decision.feedback
					? { approved: true, feedback: decision.feedback }
					: { approved: true }
			}
			if (decision.action === 'reject_plan') {
				return { approved: false, feedback: decision.feedback }
			}

			return { approved: false, feedback: `Action: ${decision.action}` }
		})

		const eventTranslator = new EventTranslator(ctx.recorder, undefined, ctx.log)
		eventTranslator.wireActivityStore(ctx.activityStore)
		eventTranslator.wirePlanManager(ctx.planManager)
		let interruptHooksStarted = false
		const executeUserInterruptHooks = async (terminalError: unknown): Promise<void> => {
			if (
				interruptHooksStarted ||
				!params.pluginManager ||
				!isCallerAbortError(terminalError, ctx.abortController.signal) ||
				params.parentSessionId !== undefined ||
				(params.depth ?? 0) !== 0 ||
				cancelCauseOf(ctx.abortController.signal.reason) !== 'user'
			) {
				return
			}

			interruptHooksStarted = true
			try {
				// Deliberately omit the already-aborted run signal. The lifecycle
				// manager still supplies each handler its own deadline signal, while
				// `run_interrupt`'s observational fan-out prevents one result from
				// suppressing the cleanup hooks that follow it.
				await params.pluginManager.executeHooks(
					'turn_interrupt',
					{ sessionId: ctx.sessionId, turnId: ctx.turnId, cancelCause: 'user' },
					eventTranslator.emitEvent,
				)
			} catch (error) {
				// Cancellation is the terminal authority. A hook event sink or an
				// unexpected manager failure is reported, but cannot turn Stop into a
				// failed turn or prevent the durable cancellation verdict.
				ctx.log.error('Turn interrupt hooks did not settle cleanly', {
					[NAMZU.TURN_ID]: ctx.turnId,
					...errorAttributes(error),
				})
			}
		}

		return {
			turnConfig,
			budget,
			storage,
			log,
			ctx,
			resilientProvider,
			serving,
			providerContextWindow,
			modelContextWindows,
			approvalPolicy,
			eventTranslator,
			executeUserInterruptHooks,
			pendingHistoryRepairs,
			initialMessages,
			historyIds,
			queuedForThisRun,
			selectedResumeState,
			attachmentResolutionCancelled,
			streamIdleTimeoutMs,
			sandboxTeardownTimeoutMs,
			promptCache,
			taskScheduler,
		}
	} catch (error) {
		await ctx.recorder.release()
		throw error
	}
}

/**
 * The ledger reference a resumed turn continues: the selected resume state's
 * binding, or the one its checkpoint document carries.
 */
async function savedBudgetReference(
	params: QueryParams,
	turnId: TurnId,
	storage: SessionStorage,
	selected: SelectedResumeState | undefined,
): Promise<SavedBudgetReference | undefined> {
	if (selected?.budgetBinding) {
		return { binding: selected.budgetBinding, accountId: selected.budgetBinding.accountId }
	}
	// A selected state carries only a durable binding. An account held in
	// memory is named by the checkpoint document alone, and a resume must
	// still see it, so the host is asked for that authority rather than
	// handed a fresh ledger.
	if (!params.resumeFromCheckpoint) return undefined
	const checkpoint = await storage.checkpoints.read(
		{
			tenantId: params.tenantId,
			projectId: params.projectId,
			sessionId: params.sessionId,
			turnId,
		},
		params.resumeFromCheckpoint,
	)
	if (!checkpoint) throw new Error('Cannot restore a token budget from a missing checkpoint.')
	return checkpoint.budget
		? {
				...(checkpoint.budget.binding ? { binding: checkpoint.budget.binding } : {}),
				accountId: checkpoint.budget.accountId,
			}
		: undefined
}

/**
 * The folded history a new turn starts from, projected the way a fresh turn
 * treats historical system messages: the prompt floor is rebuilt for this
 * turn, so only the two state-bearing system forms survive, and an inherited
 * compaction summary is pinned. `ids` receives the record id of every
 * message that survives.
 */
function projectRecordedHistory(
	history: readonly RecordedMessage[],
	ids: Map<Message, MessageId>,
): Message[] {
	const projected: Message[] = []
	for (const { message, messageId } of history) {
		let kept: Message | undefined
		if (message.role !== 'system') kept = message
		else if (isCompactionMessage(message.content)) kept = { ...message, retain: true }
		else if (isWorkingMemoryMessage(message.content)) kept = message
		if (!kept) continue
		if (messageId) ids.set(kept, messageId)
		projected.push(kept)
	}
	return projected
}

/**
 * `messages` without the leading run of messages the session log already
 * holds, compared by value. A host that passes only the new input is
 * unaffected; one that passes the whole conversation adds only its tail.
 */
function withoutRecordedPrefix(
	messages: readonly Message[],
	history: readonly RecordedMessage[],
): Message[] {
	const recorded = history.filter((entry) => entry.message.role !== 'system')
	let matched = 0
	let r = 0
	for (const message of messages) {
		if (message.role === 'system') {
			matched++
			continue
		}
		const next = recorded[r]
		if (!next || JSON.stringify(next.message) !== JSON.stringify(message)) break
		r++
		matched++
	}
	if (r === 0) return [...messages]
	return messages.slice(matched)
}

/**
 * A new turn named by the host must not reuse the id of a turn the session
 * already holds: two `turn_started` records under one id would be one turn
 * to every reader. Only checked when the host names the id; a generated one
 * is new by construction.
 */
async function assertTurnIdIsNew(
	params: QueryParams,
	turnId: TurnId,
	storage: SessionStorage,
): Promise<void> {
	if (params.turnId === undefined) return
	for await (const { record } of storage.log.read({ mode: 'tolerant' })) {
		if (record.type === 'turn_started' && record.turnId === turnId) {
			throw new NamzuError({
				code: 'invalid_config',
				message: `Turn ${turnId} already exists in session ${params.sessionId}. A new turn needs a new id; to continue that turn, pass resumeFromCheckpoint.`,
				details: { sessionId: params.sessionId, turnId },
			})
		}
	}
}

/**
 * One active turn per session (spec §4.5). A new turn is refused while
 * another is running, paused or interrupted — unless it is interrupted and
 * the caller opted into closing it. A resume must name the active turn.
 */
async function assertTurnMayStart(
	params: QueryParams,
	turnId: TurnId,
	storage: SessionStorage,
	ctx: TurnContext,
): Promise<void> {
	const lease = ctx.recorder.lease
	const active = await storage.log.activeTurn(lease ? { lease } : {})
	if (params.resumeFromCheckpoint) {
		if (active?.turnId === turnId) return
		if (active) {
			throw new TurnInProgressError({
				sessionId: params.sessionId,
				activeTurnId: active.turnId,
				state: active.state,
			})
		}
		throw new NamzuError({
			code: 'invalid_config',
			message: `Turn ${turnId} is not the active turn of session ${params.sessionId}; a settled turn cannot be resumed.`,
			details: { sessionId: params.sessionId, turnId },
		})
	}
	if (!active) return assertTurnIdIsNew(params, turnId, storage)
	if (active.state === 'interrupted' && params.abandonInterrupted) {
		return assertTurnIdIsNew(params, turnId, storage)
	}
	throw new TurnInProgressError({
		sessionId: params.sessionId,
		activeTurnId: active.turnId,
		state: active.state,
	})
}
