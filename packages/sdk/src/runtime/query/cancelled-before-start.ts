import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import { GENAI, NAMZU, agentTurnSpanName, parentContext } from '../../telemetry/attributes.js'
import { getTracer } from '../../telemetry/runtime-accessors.js'
import type { MessageId } from '../../types/ids/index.js'
import { type Message, createSystemMessage } from '../../types/message/index.js'
import type { SessionEvent, Turn } from '../../types/session/index.js'
import {
	type SessionLogCursor,
	type SessionLogReplay,
	resolveSessionLogReplay,
} from '../../types/session/log-cursor.js'
import { SESSION_EVENT_TYPES, type SessionRecord } from '../../types/session/records.js'
import { toErrorMessage } from '../../utils/error.js'
import type { QueryParams } from './index.js'
import type { PreparedTurn } from './prepare-turn.js'
import { ResultAssembler } from './result.js'

/**
 * The turn that was cancelled before it started.
 *
 * Attachment materialization happens before the turn's context exists, and
 * a cancellation observed there still belongs to a turn: it is recorded and
 * reported like any other, without any of the authority-bearing work —
 * prompt contributions, host callbacks, tools, plugins, sandbox, guardrails,
 * advisors, providers — that a turn which is allowed to proceed would do next.
 */
export async function* settlePreStartCancellation(
	params: QueryParams,
	prepared: PreparedTurn,
): AsyncGenerator<SessionEvent, Turn> {
	const {
		ctx,
		turnConfig,
		eventTranslator,
		executeUserInterruptHooks,
		selectedResumeState,
		queuedForThisRun,
		initialMessages,
		historyIds,
	} = prepared

	// Attachment materialization happens before TurnContext exists. Once it
	// observes cancellation, do only the work required to leave an honest
	// durable run: initialize the record, retain the unresolved references,
	// and settle through the ordinary cancellation classifier. Prompt
	// contributions/cache, host callbacks, tools, plugins, sandbox, guardrails,
	// advisors, and providers are all authority-bearing work and stay out.
	// The dedicated root interrupt notification is the sole plugin exception:
	// it runs after cancellation under its own deadline and cannot regain model
	// or tool authority.
	if (params.resumeFromCheckpoint && !selectedResumeState) {
		// The canonical resume surface hands query the checkpoint state it
		// already selected. A raw resume query has no such snapshot; after
		// cancellation, reading the store again could hang without a signal,
		// while persisting without it would erase the existing transcript.
		// Refuse before binding/persisting rather than choose either failure.
		ctx.abortController.signal.throwIfAborted()
	}

	const cancelledPrompt = params.systemPrompt ?? ''
	const cancelledAssembler = new ResultAssembler({
		recorder: ctx.recorder,
		planManager: ctx.planManager,
		activityStore: ctx.activityStore,
		log: ctx.log,
		emitEvent: eventTranslator.emitEvent,
		drainPending: () => eventTranslator.drainPending(),
		signal: ctx.abortController.signal,
	})
	const rootSpan = getTracer().startSpan(
		agentTurnSpanName(params.agentName),
		{},
		parentContext(params.parentSpan ?? selectedResumeState?.traceContext),
	)
	rootSpan.setAttributes({
		[GENAI.CONVERSATION_ID]: ctx.sessionId,
		[NAMZU.TURN_ID]: ctx.turnId,
		...(params.parentSessionId !== undefined && {
			[NAMZU.SESSION_PARENT_ID]: params.parentSessionId,
		}),
		[GENAI.AGENT_NAME]: params.agentName,
		[GENAI.AGENT_ID]: params.agentId,
		[GENAI.REQUEST_MODEL]: turnConfig.model,
		[GENAI.SYSTEM]: params.provider.id,
	})

	const push = (message: Message, ids: ReadonlyMap<Message, MessageId>): void => {
		const messageId = ids.get(message)
		ctx.recorder.pushMessage(message, messageId ? { messageId } : {})
	}
	try {
		if (selectedResumeState) {
			ctx.recorder.restoreUsage(
				selectedResumeState.tokenUsage,
				selectedResumeState.costInfo,
				selectedResumeState.currentIteration,
			)
			const restoredIds = selectedResumeState.messageIds ?? new Map<Message, MessageId>()
			for (const message of selectedResumeState.messages) push(message, restoredIds)
		} else if (params.continuationMode) {
			for (const message of initialMessages) push(message, historyIds)
		} else {
			ctx.recorder.pushMessage(createSystemMessage(cancelledPrompt, 'cache'), { transient: true })
			for (const message of initialMessages) push(message, historyIds)
		}
		if (params.eventCursor) {
			yield* catchUpFromCursor(ctx.recorder, params.eventCursor, params.onEventReplay, (error) => {
				ctx.log.warn('Replay observer failed after attachment cancellation', {
					'exception.message': toErrorMessage(error),
				})
			})
		}
		ctx.recorder.markRunning()
		if (selectedResumeState) {
			await eventTranslator.resumeTurn(selectedResumeState.checkpointId)
			for (const queued of queuedForThisRun) ctx.recorder.pushMessage(queued)
		} else {
			await eventTranslator.beginTurn({
				systemPrompt: cancelledPrompt,
				...(params.origin ? { origin: params.origin } : {}),
				...(params.abandonInterrupted ? { abandonInterrupted: true } : {}),
			})
		}
		yield* eventTranslator.drainPending()
		ctx.abortController.signal.throwIfAborted()
	} catch (error) {
		// Attachment resolution has already observed the caller's abort. A
		// reconnect callback can still throw while replay is being reported,
		// but it cannot replace that terminal cause or turn a cancelled run
		// into an unpersisted rejection.
		const terminalError = ctx.abortController.signal.aborted
			? ctx.abortController.signal.reason
			: error
		await executeUserInterruptHooks(terminalError)
		yield* eventTranslator.drainPending()
		yield* cancelledAssembler.handleError(terminalError, rootSpan)
	} finally {
		rootSpan.end()
	}

	return await cancelledAssembler.finalize()
}

/**
 * Hand a returning consumer what it missed, or tell it why it cannot have it.
 *
 * Yields NOTHING on a refusal. A partial catch-up is the failure this exists to
 * prevent: a consumer that receives some of the gap folds it into its state and
 * cannot tell the state is wrong, where one that receives an explicit
 * `unavailable` re-derives from the log and is right. The turn continues
 * either way — a stale cursor belongs to the client, and must not be able to
 * stop the work.
 *
 * What is yielded is the live events the missed records stand for; the
 * record-only types (messages, checkpoints, decisions) are in the log and not
 * on the stream.
 */
export async function* catchUpFromCursor(
	recorder: TurnRecorder,
	cursor: SessionLogCursor,
	onEventReplay: ((replay: SessionLogReplay) => void) | undefined,
	onReplayObserverError: (error: unknown) => void,
): AsyncGenerator<SessionEvent, void> {
	const head = await recorder.log.head()
	const missed: SessionRecord[] = []
	if (head && cursor.sinceSeq < head.pointer.seq) {
		for await (const { record } of recorder.log.read()) {
			if (record.seq > cursor.sinceSeq) missed.push(record)
		}
	}
	const replay = resolveSessionLogReplay(cursor, head, missed)

	if (onEventReplay) {
		try {
			// Observe a Promise an `async` observer may return, without
			// awaiting host code here.
			const settlement = onEventReplay(replay)
			void Promise.resolve(settlement).catch(onReplayObserverError)
		} catch (error) {
			onReplayObserverError(error)
		}
	}

	if (replay.status !== 'replayed') return
	for (const record of replay.records) {
		const event = liveEventOfRecord(record)
		if (event) yield event
	}
}

const LIVE_TYPES: ReadonlySet<string> = new Set(SESSION_EVENT_TYPES)

/** The live event a persisted-event record stands for; `undefined` for a record-only type. */
export function liveEventOfRecord(record: SessionRecord): SessionEvent | undefined {
	if (!LIVE_TYPES.has(record.type)) return undefined
	const {
		v: _v,
		id: _id,
		ts: _ts,
		prev: _prev,
		prevText: _prevText,
		gen,
		...payload
	} = record as SessionRecord & { prevText?: unknown }
	return { ...payload, generation: gen } as unknown as SessionEvent
}
