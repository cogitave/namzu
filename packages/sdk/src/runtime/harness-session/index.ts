import { posix, win32 } from 'node:path'
import {
	HarnessBindingSchema,
	HarnessDecisionSchema,
	HarnessEventSchema,
	HarnessNativeTurnSchema,
	HarnessReviewRequestSchema,
	harnessSnapshot,
} from '../../types/harness/schema.js'
import type {
	HarnessAdmissionRequest,
	HarnessBinding,
	HarnessConnection,
	HarnessDecision,
	HarnessEvent,
	HarnessHistorySnapshot,
	HarnessJournalTransition,
	HarnessNativeItem,
	HarnessNativeTurn,
	HarnessPrompt,
	HarnessReviewRequest,
	HarnessSession,
	HarnessSessionOptions,
	HarnessTurnOutcome,
} from '../../types/harness/session.js'
import type { MessageId, TurnId } from '../../types/ids/index.js'
import type { AssistantMessage, Message } from '../../types/message/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import type { TurnSettlement } from '../../types/session/turn.js'
import {
	generateMessageId,
	generateToolCallId,
	generateTurnId,
	isEntityId,
} from '../../utils/id.js'
import { HarnessJournal, HarnessSessionError, harnessDigest } from './journal.js'

type Payload<E> = E extends unknown ? Omit<E, 'sessionId' | 'turnId'> : never
type EventPayload = Payload<SessionEvent>

interface Item {
	messageId?: MessageId
	toolUseId?: string
	started: boolean
	completed?: string
	content: string
	blocks: Map<string, number>
}
interface Active {
	turnId: TurnId
	operationId: string
	startedAt: number
	nativeTurn?: HarnessNativeTurn
	items: Map<string, Item>
	reviews: Map<
		string,
		{
			request: HarnessReviewRequest
			digest: string
			decision?: string
			resolved: boolean
			presented?: boolean
		}
	>
	resolve: (outcome: HarnessTurnOutcome) => void
	reject: (error: unknown) => void
	done: Promise<HarnessTurnOutcome>
	abortRequested?: boolean
	removeAbort?: () => void
}

/** Vendor execution remains outside the Namzu query kernel and tool executor. */
export function createHarnessSession(options: HarnessSessionOptions): HarnessSession {
	return new ExternalHarnessSession(options)
}
export { HarnessSessionError } from './journal.js'

class ExternalHarnessSession implements HarnessSession {
	readonly scope: HarnessSession['scope']
	private readonly journal: HarnessJournal
	private readonly openAdapter: HarnessSessionOptions['adapter']['open']
	private readonly admit: HarnessSessionOptions['assertAdmission']
	private readonly publish: HarnessSessionOptions['onEvent']
	private readonly review: HarnessSessionOptions['onReview']
	private currentBinding?: HarnessBinding
	private connection?: HarnessConnection
	private active?: Active
	private phase: HarnessSession['status'] = 'disconnected'
	private operation = false
	private cancelling = false
	private epoch = 0
	private events: Promise<void> = Promise.resolve()
	private eventError?: unknown

	constructor(options: HarnessSessionOptions) {
		this.scope = harnessSnapshot(options.scope)
		if (
			!isEntityId(this.scope.sessionId, 'session') ||
			!isEntityId(this.scope.projectId, 'project') ||
			!isEntityId(this.scope.tenantId, 'tenant') ||
			!isEntityId(this.scope.topicId, 'topic') ||
			!(posix.isAbsolute(this.scope.cwd) || win32.isAbsolute(this.scope.cwd)) ||
			Array.from(this.scope.cwd).some((c) => c.charCodeAt(0) < 32)
		)
			throw new HarnessSessionError(
				'invalid-scope',
				'An exact owner scope and canonical absolute native directory are required.',
			)
		if (
			typeof options.assertAdmission !== 'function' ||
			typeof options.onEvent !== 'function' ||
			typeof options.onReview !== 'function'
		)
			throw new HarnessSessionError(
				'invalid-host',
				'Explicit admission, event and review host ports are required.',
			)
		this.journal = new HarnessJournal(
			options.sessionLog,
			this.scope,
			options.adapter.engineId,
			options.adapter.profileRef,
		)
		this.openAdapter = options.adapter.open.bind(options.adapter)
		this.admit = options.assertAdmission
		this.publish = options.onEvent
		this.review = options.onReview
	}
	get binding() {
		return this.currentBinding
	}
	get currentTurnId() {
		return this.active?.turnId
	}
	get status() {
		return this.phase
	}

	private hasUnresolved(): boolean {
		return (
			!!this.active || this.phase === 'reconciliation-required' || this.eventError !== undefined
		)
	}
	private reserve(): () => void {
		if (this.phase === 'closed')
			throw new HarnessSessionError('closed', 'This harness session is closed.')
		if (this.operation || this.cancelling)
			throw new HarnessSessionError('busy', 'Another harness operation is pending.')
		this.operation = true
		let released = false
		return () => {
			if (released) return
			released = true
			this.operation = false
		}
	}
	private async authorize(
		kind: HarnessAdmissionRequest['kind'],
		signal?: AbortSignal,
		request?: HarnessReviewRequest,
	): Promise<void> {
		if (signal?.aborted)
			throw new HarnessSessionError('aborted', 'The operation was aborted before dispatch.')
		await this.admit(
			harnessSnapshot({
				kind,
				scope: this.scope,
				...(this.currentBinding ? { binding: this.currentBinding } : {}),
				...(this.active?.nativeTurn ? { nativeTurn: this.active.nativeTurn } : {}),
				...(request ? { review: request } : {}),
			}),
			signal,
		)
		if (signal?.aborted)
			throw new HarnessSessionError('aborted', 'The operation was aborted before dispatch.')
	}
	async history(): Promise<readonly Message[]> {
		const state = await this.journal.inspect()
		this.currentBinding ??= state.binding
		return harnessSnapshot(await this.journal.log.messages())
	}

	private requireConnection(): HarnessConnection {
		if (!this.connection)
			throw new HarnessSessionError('disconnected', 'The native connection is not ready.')
		return this.connection
	}
	private capture(connection: HarnessConnection): HarnessConnection {
		const binding = harnessSnapshot(HarnessBindingSchema.parse(connection.binding))
		this.journal.validateBinding(binding)
		if (this.currentBinding && harnessDigest(this.currentBinding) !== harnessDigest(binding))
			throw new HarnessSessionError(
				'binding-mismatch',
				'The adapter resumed a different native session.',
			)
		return Object.freeze({
			binding,
			capabilities: harnessSnapshot(connection.capabilities),
			models: connection.models.bind(connection),
			dispatch: connection.dispatch.bind(connection),
			interrupt: connection.interrupt.bind(connection),
			respond: connection.respond.bind(connection),
			readHistory: connection.readHistory.bind(connection),
			close: connection.close.bind(connection),
		})
	}
	private async connect(model?: string, signal?: AbortSignal): Promise<void> {
		if (this.connection) return
		const stored = await this.journal.inspect()
		this.currentBinding = stored.binding
		await this.authorize(stored.binding ? 'reconnect' : 'open', signal)
		await this.journal.claim()
		await this.authorize(stored.binding ? 'reconnect' : 'open', signal)
		const epoch = ++this.epoch
		let accepting = false
		const early: HarnessEvent[] = []
		let earlyBytes = 0
		const sink = (input: HarnessEvent): Promise<void> => {
			if (epoch !== this.epoch || this.phase === 'closed') return Promise.resolve()
			let event: HarnessEvent
			try {
				event = harnessSnapshot(HarnessEventSchema.parse(input))
			} catch (error) {
				return this.enqueueTask(() => Promise.reject(error), epoch)
			}
			if (!accepting) {
				earlyBytes += JSON.stringify(event).length
				if (early.length >= 256 || earlyBytes > 1024 * 1024)
					return this.enqueueTask(
						() =>
							Promise.reject(
								new HarnessSessionError(
									'early-events-overflow',
									'The adapter exceeded the bounded pre-binding event queue.',
								),
							),
						epoch,
					)
				early.push(event)
				return Promise.resolve()
			}
			return this.enqueue(event, epoch)
		}
		try {
			const opened = await this.openAdapter(
				{
					cwd: this.scope.cwd,
					...(model ? { model } : {}),
					...(stored.binding ? { resume: stored.binding } : {}),
					...(signal ? { signal } : {}),
				},
				sink,
			)
			// Retain even an invalid returned handle until owned cleanup is confirmed.
			this.connection = opened
			this.connection = this.capture(opened)
			this.currentBinding = this.connection.binding
			await this.authorize(stored.binding ? 'reconnect' : 'open', signal)
			await this.journal.start(this.currentBinding)
			await this.restoreActive(stored.transitions)
			accepting = true
			for (const event of early) await this.enqueue(event, epoch)
			if (stored.binding && !this.active && this.connection.capabilities.history === 'snapshot') {
				const snapshot = harnessSnapshot(await this.connection.readHistory(signal))
				if (
					!snapshot.complete ||
					harnessDigest(snapshot.binding) !== harnessDigest(this.currentBinding) ||
					snapshot.activeTurn ||
					snapshot.pendingReviews.length
				)
					throw new HarnessSessionError(
						'reconciliation-required',
						'Native session history did not confirm an idle exact binding.',
					)
			}
			if (!this.active && this.phase !== 'reconciliation-required') this.phase = 'idle'
		} catch (error) {
			if (this.connection) {
				try {
					await this.connection.close()
					this.connection = undefined
					++this.epoch
					await this.journal.release()
				} catch (cleanup) {
					this.phase = 'reconciliation-required'
					throw new AggregateError(
						[error, cleanup],
						'Harness open failed and its process could not be confirmed stopped.',
					)
				}
			} else await this.journal.release()
			throw error
		}
	}
	private makeActive(turnId: TurnId, operationId: string, startedAt: number): Active {
		let resolve!: Active['resolve']
		let reject!: Active['reject']
		const done = new Promise<HarnessTurnOutcome>((yes, no) => {
			resolve = yes
			reject = no
		})
		void done.catch(() => undefined)
		return {
			turnId,
			operationId,
			startedAt,
			items: new Map(),
			reviews: new Map(),
			resolve,
			reject,
			done,
		}
	}
	private async restoreActive(transitions: readonly HarnessJournalTransition[]): Promise<void> {
		const pending = await this.journal.log.activeTurn({ lease: await this.journal.current() })
		if (!pending) {
			this.active?.removeAbort?.()
			this.active = undefined
			return
		}
		const prepared = [...transitions]
			.reverse()
			.find((e) => e.kind === 'dispatch-prepared' && e.turnId === pending.turnId)
		if (!prepared || prepared.kind !== 'dispatch-prepared')
			throw new HarnessSessionError(
				'invalid-journal',
				'The active harness turn has no prepared dispatch receipt.',
			)
		const active = this.makeActive(pending.turnId, prepared.operationId, Date.now())
		for (const entry of transitions) {
			if (!('turnId' in entry) || entry.turnId !== pending.turnId) continue
			if (entry.kind === 'dispatch-accepted') {
				if (entry.operationId !== active.operationId)
					throw new HarnessSessionError(
						'invalid-journal',
						'Dispatch receipt does not match the prepared operation.',
					)
				this.validateNative(entry.nativeTurn, active)
				active.nativeTurn = harnessSnapshot(entry.nativeTurn)
			} else if (entry.kind === 'item-bound') {
				this.validateNative(entry.nativeItem, active)
				active.items.set(entry.nativeItem.nativeItemId, {
					messageId: entry.messageId,
					toolUseId: entry.toolUseId,
					started: false,
					content: '',
					blocks: new Map(),
				})
			} else if (entry.kind === 'review-requested') {
				this.validateNative(entry.request, active)
				if (harnessDigest(entry.request) !== entry.digest)
					throw new HarnessSessionError(
						'invalid-journal',
						'The native review digest does not match its captured request.',
					)
				active.reviews.set(entry.request.requestId, {
					request: harnessSnapshot(entry.request),
					digest: entry.digest,
					resolved: false,
				})
			} else if (entry.kind === 'review-decided') {
				const review = active.reviews.get(entry.requestId)
				if (
					!review ||
					review.digest !== entry.requestDigest ||
					harnessDigest(entry.decision) !== entry.decisionDigest
				)
					throw new HarnessSessionError(
						'invalid-journal',
						'The native decision does not match its recorded request.',
					)
				review.decision = entry.decisionDigest
			} else if (entry.kind === 'review-resolved') {
				const review = active.reviews.get(entry.requestId)
				if (review) review.resolved = true
			}
		}
		const { entries } = await this.journal.log.readAll()
		for (const { record } of entries) {
			if (record.turnId !== active.turnId) continue
			if (record.type === 'turn_started') active.startedAt = Date.parse(record.ts)
			if (record.type === 'message')
				for (const item of active.items.values())
					if (item.messageId === record.messageId && record.role === 'assistant') {
						item.started = true
						item.completed = harnessDigest(record.content)
						item.content = typeof record.content.content === 'string' ? record.content.content : ''
					}
		}
		this.active = active
		this.phase = 'reconciliation-required'
	}

	async run(input: Omit<HarnessPrompt, 'operationId'>): Promise<HarnessTurnOutcome> {
		const signal = input.signal
		const prompt = harnessSnapshot({
			prompt: input.prompt,
			model: input.model,
			permissionMode: input.permissionMode,
			...(input.effort ? { effort: input.effort } : {}),
		})
		const release = this.reserve()
		if (
			!prompt.prompt ||
			prompt.prompt.length > 1024 * 1024 ||
			!prompt.model ||
			prompt.model.length > 4096
		) {
			release()
			throw new HarnessSessionError(
				'invalid-prompt',
				'A bounded prompt and explicit model are required.',
			)
		}
		let active: Active | undefined
		let dispatchInvoked = false
		try {
			if (this.hasUnresolved())
				throw new HarnessSessionError(
					'reconciliation-required',
					'A previous turn must be reconciled before sending another prompt.',
				)
			await this.connect(prompt.model, signal)
			if (this.hasUnresolved())
				throw new HarnessSessionError(
					'reconciliation-required',
					'The journal contains an unresolved native dispatch; it will not be resent.',
				)
			const connection = this.connection as HarnessConnection
			if (!connection.capabilities.reviewModes.includes(prompt.permissionMode))
				throw new HarnessSessionError(
					'unsupported-mode',
					'This harness does not support the selected review mode.',
				)
			if (prompt.effort && !connection.capabilities.effortLevels?.includes(prompt.effort))
				throw new HarnessSessionError(
					'unsupported-effort',
					'This harness does not support the selected effort.',
				)
			await this.authorize('run', signal)
			const lease = await this.journal.current()
			const turnId = generateTurnId()
			const promptId = generateMessageId()
			const operationId = `${turnId}:${promptId}`
			active = this.makeActive(turnId, operationId, Date.now())
			this.active = active
			const entry = await this.journal.log.beginTurn(lease, {
				turnId,
				userMessageId: promptId,
				config: { model: prompt.model, tokenBudget: 0, timeoutMs: 0 },
				origin: { protocol: 'sdk', kind: 'prompt' },
			})
			await this.journal.append({
				type: 'message',
				turnId,
				messageId: promptId,
				role: 'user',
				kind: 'prompt',
				content: { role: 'user', content: prompt.prompt },
			})
			await this.journal.transition({
				kind: 'dispatch-prepared',
				model: prompt.model,
				permissionMode: prompt.permissionMode,
				...(prompt.effort ? { effort: prompt.effort } : {}),
				operationId,
				turnId,
				promptId,
				digest: harnessDigest(prompt),
			})
			this.phase = 'running'
			await this.publish({
				type: 'turn_started',
				sessionId: this.scope.sessionId,
				turnId,
				userMessageId: promptId,
				config: { model: prompt.model, tokenBudget: 0, timeoutMs: 0 },
				v: 1,
				seq: entry.record.seq,
				generation: entry.record.gen,
			})
			// Recheck current host authority and writer immediately before the external effect.
			await this.authorize('run', signal)
			await this.journal.current()
			if (signal) {
				const ownTurn = active
				const abort = () => {
					ownTurn.abortRequested = true
					if (ownTurn.nativeTurn)
						void this.cancel(ownTurn.turnId).catch((error: unknown) => ownTurn.reject(error))
				}
				signal.addEventListener('abort', abort, { once: true })
				active.removeAbort = () => signal.removeEventListener('abort', abort)
			}
			release() // cancellation/review is admitted while the durable native turn runs
			dispatchInvoked = true
			const nativeTurn = harnessSnapshot(
				HarnessNativeTurnSchema.parse(
					await connection.dispatch({ ...prompt, operationId, ...(signal ? { signal } : {}) }),
				),
			)
			await this.events
			if (this.eventError) throw this.eventError
			if (this.active === active) await this.bindNative(nativeTurn, active)
			else this.validateNative(nativeTurn, active) // terminal before ACK must not reactivate
			return await active.done
		} catch (error) {
			if (active && this.active === active) {
				if (dispatchInvoked) await this.uncertain('dispatch-unconfirmed', error)
				else await this.failBeforeDispatch(active)
			}
			throw error
		} finally {
			release()
		}
	}
	private async failBeforeDispatch(active: Active): Promise<void> {
		const settlement = this.settlement(active, 'failed')
		await this.emit(active, {
			type: 'turn_failed',
			error: 'The host refused this prompt before native dispatch.',
			settlement,
		})
		active.removeAbort?.()
		active.reject(new HarnessSessionError('dispatch-refused', 'No native dispatch occurred.'))
		this.active = undefined
		this.phase = 'idle'
	}

	private validateNative(native: HarnessNativeTurn, active: Active): void {
		if (
			native.nativeSessionId !== this.currentBinding?.nativeSessionId ||
			(native.turnIdSource === 'operation' && native.nativeTurnId !== active.operationId)
		)
			throw new HarnessSessionError(
				'native-owner-mismatch',
				'Native event does not belong to this session and dispatch operation.',
			)
		if (
			active.nativeTurn &&
			(active.nativeTurn.nativeSessionId !== native.nativeSessionId ||
				active.nativeTurn.nativeTurnId !== native.nativeTurnId ||
				(active.nativeTurn.turnIdSource ?? 'engine') !== (native.turnIdSource ?? 'engine'))
		)
			throw new HarnessSessionError('native-turn-mismatch', 'Native event names a different turn.')
	}
	private async bindNative(native: HarnessNativeTurn, active: Active): Promise<void> {
		this.validateNative(native, active)
		if (active.nativeTurn) return
		active.nativeTurn = harnessSnapshot({
			nativeSessionId: native.nativeSessionId,
			nativeTurnId: native.nativeTurnId,
			...(native.turnIdSource ? { turnIdSource: native.turnIdSource } : {}),
		})
		await this.journal.transition({
			kind: 'dispatch-accepted',
			operationId: active.operationId,
			turnId: active.turnId,
			nativeTurn: active.nativeTurn,
		})
		if (active.abortRequested)
			void this.cancel(active.turnId).catch((error: unknown) => active.reject(error))
	}
	private enqueue(event: HarnessEvent, epoch: number): Promise<void> {
		return this.enqueueTask(() => this.consume(event), epoch)
	}
	private enqueueTask(operation: () => Promise<void>, epoch: number): Promise<void> {
		const next = this.events.then(async () => {
			if (epoch !== this.epoch) return
			if (this.eventError !== undefined) throw this.eventError
			await operation()
		})
		this.events = next.catch(async (error: unknown) => {
			if (this.eventError === undefined) {
				this.eventError = error
				await this.uncertain('event-rejected', error)
			}
		})
		return next
	}
	private async uncertain(code: string, error: unknown): Promise<void> {
		this.phase = 'reconciliation-required'
		const active = this.active
		active?.removeAbort?.()
		active?.reject(error)
		try {
			await this.journal.transition({
				kind: 'connection-lost',
				...(active ? { turnId: active.turnId } : {}),
				code,
			})
		} catch {
			/* writer failure remains retained; never report confirmed stop */
		}
	}
	private async item(
		native: HarnessNativeItem,
		active: Active,
		kind: 'message' | 'tool',
	): Promise<Item> {
		let item = active.items.get(native.nativeItemId)
		if (!item) {
			item = { started: false, content: '', blocks: new Map() }
			active.items.set(native.nativeItemId, item)
		}
		if (kind === 'message' && !item.messageId) item.messageId = generateMessageId()
		else if (kind === 'tool' && !item.toolUseId) item.toolUseId = generateToolCallId()
		else return item
		await this.journal.transition({
			kind: 'item-bound',
			turnId: active.turnId,
			nativeItem: {
				nativeSessionId: native.nativeSessionId,
				nativeTurnId: native.nativeTurnId,
				nativeItemId: native.nativeItemId,
				...(native.turnIdSource ? { turnIdSource: native.turnIdSource } : {}),
			},
			...(item.messageId ? { messageId: item.messageId } : {}),
			...(item.toolUseId ? { toolUseId: item.toolUseId } : {}),
		})
		return item
	}
	private async emit(active: Active, event: EventPayload): Promise<void> {
		await this.journal.event(
			{ ...event, sessionId: this.scope.sessionId, turnId: active.turnId } as SessionEvent,
			this.publish,
		)
	}
	private async consume(event: HarnessEvent): Promise<void> {
		if (event.kind === 'connection-lost') {
			const error = new HarnessSessionError(
				'connection-lost',
				'Native connection was lost; dispatch recovery is required.',
			)
			this.eventError = error
			await this.uncertain(event.code, error)
			return
		}
		const active = this.active
		if (!active) return // never revive a terminal turn from transport tails
		const native = event.kind === 'review-requested' ? event.request : event
		await this.bindNative(native, active)
		switch (event.kind) {
			case 'turn-started':
				return
			case 'review-requested': {
				const digest = harnessDigest(event.request)
				const old = active.reviews.get(event.request.requestId)
				if (old) {
					if (old.digest !== digest)
						throw new HarnessSessionError(
							'review-conflict',
							'Native request ID was reused with different input.',
						)
					return
				}
				active.reviews.set(event.request.requestId, {
					request: event.request,
					digest,
					resolved: false,
				})
				await this.journal.transition({
					kind: 'review-requested',
					turnId: active.turnId,
					request: event.request,
					digest,
				})
				this.phase = 'waiting'
				await this.review(event.request)
				const presented = active.reviews.get(event.request.requestId)
				if (presented) presented.presented = true
				return
			}
			case 'review-resolved': {
				const review = active.reviews.get(event.requestId)
				if (!review || review.resolved) return
				review.resolved = true
				await this.journal.transition({
					kind: 'review-resolved',
					turnId: active.turnId,
					requestId: event.requestId,
				})
				if (![...active.reviews.values()].some((r) => !r.resolved)) this.phase = 'running'
				return
			}
			case 'turn-completed':
				await this.finish(active, event)
				return
			case 'tool-started': {
				const item = await this.item(event, active, 'tool')
				if (item.started) return
				item.started = true
				await this.emit(active, {
					type: 'tool_executing',
					toolUseId: item.toolUseId as string,
					toolName: `${this.currentBinding?.engineId}:${event.name}`,
					input: event.input,
				})
				return
			}
			case 'tool-output': {
				const item = await this.item(event, active, 'tool')
				await this.emit(active, {
					type: 'tool_progress',
					toolUseId: item.toolUseId as string,
					toolName: this.currentBinding?.engineId ?? 'harness',
					message: event.text,
				})
				return
			}
			case 'tool-completed': {
				const item = await this.item(event, active, 'tool')
				const digest = harnessDigest(event)
				if (item.completed === digest) return
				if (item.completed)
					throw new HarnessSessionError(
						'item-conflict',
						'Native tool completion changed after settlement.',
					)
				item.completed = digest
				await this.emit(active, {
					type: 'tool_completed',
					toolUseId: item.toolUseId as string,
					toolName: `${this.currentBinding?.engineId}:${event.name}`,
					result: event.result,
					isError: event.status !== 'completed',
					...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
				})
				return
			}
			case 'message-started':
			case 'text-delta':
			case 'message-completed':
			case 'reasoning': {
				const item = await this.item(event, active, 'message')
				const messageId = item.messageId as MessageId
				if (!item.started) {
					item.started = true
					await this.emit(active, { type: 'message_started', iteration: 0, messageId })
				}
				if (event.kind === 'text-delta') {
					if (item.completed) return
					item.content += event.text
					await this.emit(active, {
						type: 'text_delta',
						iteration: 0,
						messageId,
						text: event.text,
						...(event.part ? { textPart: event.part } : {}),
					})
				} else if (event.kind === 'message-completed') {
					await this.completeMessage(active, item, event.content, event.parts, event.stopReason)
				} else if (event.kind === 'reasoning') {
					let index = item.blocks.get(event.blockId)
					if (index === undefined) {
						index = item.blocks.size
						item.blocks.set(event.blockId, index)
						await this.emit(active, {
							type: 'reasoning_started',
							iteration: 0,
							messageId,
							blockIndex: index,
							reasoningType: event.text === undefined ? 'redacted_thinking' : 'thinking',
						})
					}
					if (event.status === 'pending' && event.text)
						await this.emit(active, {
							type: 'reasoning_delta',
							iteration: 0,
							messageId,
							blockIndex: index,
							text: event.text,
						})
					if (event.status === 'completed')
						await this.emit(active, {
							type: 'reasoning_completed',
							iteration: 0,
							messageId,
							blockIndex: index,
							signed: false,
							...(event.text === undefined ? {} : { text: event.text }),
						})
				}
				return
			}
		}
	}
	private async completeMessage(
		active: Active,
		item: Item,
		content: string,
		parts: readonly import('../../types/harness/session.js').HarnessPublicTextPart[] | undefined,
		stopReason: import('../../types/session/stop-reason.js').MessageStopReason,
	): Promise<void> {
		const message: AssistantMessage = {
			role: 'assistant',
			content,
			...(parts ? { textParts: parts } : {}),
		}
		const digest = harnessDigest(message)
		if (item.completed === digest) return
		if (item.completed)
			await this.journal.append({
				type: 'message_replaced',
				turnId: active.turnId,
				targetMessageId: item.messageId as MessageId,
				content: message,
				reason: 'history-repair',
			})
		else
			await this.journal.append({
				type: 'message',
				turnId: active.turnId,
				messageId: item.messageId as MessageId,
				role: 'assistant',
				content: message,
			})
		item.completed = digest
		item.content = content
		await this.emit(active, {
			type: 'message_completed',
			iteration: 0,
			messageId: item.messageId as MessageId,
			content,
			...(parts ? { textParts: parts } : {}),
			stopReason,
		})
	}
	private async finish(
		active: Active,
		event: Extract<HarnessEvent, { kind: 'turn-completed' }>,
	): Promise<void> {
		let final = event.finalItemId ? active.items.get(event.finalItemId) : undefined
		if (event.result !== undefined) {
			if (!final && event.finalItemId)
				final = await this.item({ ...event, nativeItemId: event.finalItemId }, active, 'message')
			if (final?.messageId && (final.content !== event.result || !final.completed))
				await this.completeMessage(
					active,
					final,
					event.result,
					undefined,
					event.status === 'cancelled' ? 'cancelled' : 'end_turn',
				)
		}
		const result = event.result ?? final?.content ?? ''
		const settlement: TurnSettlement = this.settlement(active, event.status, final?.messageId)
		if (event.status === 'failed')
			await this.emit(active, {
				type: 'turn_failed',
				error: event.error?.message ?? 'External harness turn failed.',
				settlement,
			})
		else
			await this.emit(active, {
				type: 'turn_completed',
				result,
				stopReason: event.status === 'cancelled' ? 'cancelled' : 'end_turn',
				settlement,
			})
		active.removeAbort?.()
		this.active = undefined
		this.phase = 'idle'
		active.resolve({
			turnId: active.turnId,
			nativeTurn: active.nativeTurn as HarnessNativeTurn,
			status: event.status,
			messages: harnessSnapshot(await this.journal.log.messages()),
		})
	}
	private settlement(
		active: Active,
		status: HarnessTurnOutcome['status'],
		resultMessageId?: MessageId,
	): TurnSettlement {
		return {
			status,
			iterations: 0,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			durationMs: Math.max(0, Date.now() - active.startedAt),
			resultSource: 'model',
			...(resultMessageId ? { resultMessageId } : {}),
			abandonedJobIds: [],
			abandonedTaskIds: [],
		}
	}

	async respond(input: HarnessReviewRequest, value: HarnessDecision): Promise<void> {
		const request = harnessSnapshot(HarnessReviewRequestSchema.parse(input))
		const decision = harnessSnapshot(HarnessDecisionSchema.parse(value))
		const release = this.reserve()
		let reserved = false
		try {
			const active = this.active
			const review = active?.reviews.get(request.requestId)
			if (
				!active ||
				!review ||
				review.resolved ||
				review.decision ||
				this.phase !== 'waiting' ||
				review.digest !== harnessDigest(request)
			)
				throw new HarnessSessionError(
					'stale-review',
					'This native review request is stale, altered or already decided.',
				)
			if (!request.decisions.includes(decision.kind))
				throw new HarnessSessionError(
					'unsupported-decision',
					'The native request does not permit this decision.',
				)
			await this.authorize('approval', undefined, request)
			await this.journal.current()
			if (this.active !== active || review.resolved || review.decision)
				throw new HarnessSessionError(
					'stale-review',
					'The native request ended while authorization was pending.',
				)
			const digest = harnessDigest(decision)
			await this.journal.transition({
				kind: 'review-decided',
				turnId: active.turnId,
				requestId: request.requestId,
				requestDigest: review.digest,
				decisionDigest: digest,
				decision,
			})
			reserved = true
			review.decision = digest // durable reservation precedes native answer; unknown ACK is not retried
			await this.authorize('approval', undefined, request)
			await this.journal.current()
			if (this.active !== active || review.resolved)
				throw new HarnessSessionError(
					'stale-review',
					'The request ended before its decision could be sent.',
				)
			await (this.connection as HarnessConnection).respond(request, decision)
		} catch (error) {
			if (reserved) await this.uncertain('decision-unconfirmed', error)
			throw error
		} finally {
			release()
		}
	}
	async cancel(expectedTurnId: TurnId): Promise<{ stopped: true; turnId: TurnId }> {
		if (this.operation || this.cancelling)
			throw new HarnessSessionError('busy', 'Another harness operation is pending.')
		const active = this.active
		if (!active || active.turnId !== expectedTurnId)
			throw new HarnessSessionError('stale-turn', 'Stop does not name the current admitted turn.')
		if (!active.nativeTurn || !this.connection)
			throw new HarnessSessionError(
				'dispatch-unconfirmed',
				'The native dispatch is not confirmed; reconcile or close this session.',
			)
		this.cancelling = true
		try {
			await this.journal.current()
			if (this.connection.capabilities.interrupt === 'unavailable')
				throw new HarnessSessionError(
					'unsupported-cancel',
					'The native engine cannot confirm interruption.',
				)
			if (this.connection.capabilities.interrupt === 'process-stop') {
				await this.connection.close()
				this.connection = undefined
				++this.epoch
				if (this.active === active)
					await this.finish(active, {
						kind: 'turn-completed',
						...active.nativeTurn,
						status: 'cancelled',
					})
			} else {
				await this.connection.interrupt(active.nativeTurn)
				await active.done // ACK is not completion; exact terminal event is required
			}
			return { stopped: true, turnId: expectedTurnId }
		} finally {
			this.cancelling = false
		}
	}
	async reconnect(signal?: AbortSignal): Promise<void> {
		const release = this.reserve()
		try {
			if (this.active && this.phase !== 'reconciliation-required')
				throw new HarnessSessionError('busy', 'A native turn is still running.')
			await this.authorize('reconnect', signal)
			if (this.connection) {
				await this.connection.close()
				this.connection = undefined
				++this.epoch
			}
			await this.events
			this.eventError = undefined
			await this.connect(undefined, signal)
			if (!this.active) {
				this.phase = 'idle'
				return
			}
			await this.authorize('reconnect', signal)
			const snapshot = harnessSnapshot(await this.requireConnection().readHistory(signal))
			await this.reconcile(snapshot)
		} finally {
			release()
		}
	}
	private async reconcile(snapshot: HarnessHistorySnapshot): Promise<void> {
		if (
			!snapshot.complete ||
			harnessDigest(snapshot.binding) !== harnessDigest(this.currentBinding)
		)
			throw new HarnessSessionError(
				'reconciliation-required',
				'This engine cannot provide a complete history for the uncertain dispatch.',
			)
		const active = this.active
		if (!active?.nativeTurn)
			throw new HarnessSessionError(
				'reconciliation-required',
				'An unacknowledged dispatch has no trustworthy native turn correlation; it will not be resent.',
			)
		if (snapshot.activeTurn) this.validateNative(snapshot.activeTurn, active)
		for (const input of snapshot.events) {
			const event = harnessSnapshot(HarnessEventSchema.parse(input))
			if (event.kind === 'connection-lost') continue
			const native = event.kind === 'review-requested' ? event.request : event
			if (native.nativeTurnId !== active.nativeTurn.nativeTurnId) continue
			await this.consume(event)
		}
		if (!this.active) return
		if (!snapshot.activeTurn)
			throw new HarnessSessionError(
				'reconciliation-required',
				'Native history did not prove a terminal or an active exact turn.',
			)
		for (const input of snapshot.pendingReviews) {
			const request = harnessSnapshot(HarnessReviewRequestSchema.parse(input))
			this.validateNative(request, active)
			const pending = active.reviews.get(request.requestId)
			if (pending?.decision)
				throw new HarnessSessionError(
					'reconciliation-required',
					'A durable decision has no confirmed native resolution; it will not be sent again.',
				)
			if (pending) {
				if (pending.resolved || pending.digest !== harnessDigest(request))
					throw new HarnessSessionError(
						'reconciliation-required',
						'Native pending review contradicts its recorded request or resolution.',
					)
				if (!pending.presented) {
					await this.review(pending.request)
					pending.presented = true
				}
			} else await this.consume({ kind: 'review-requested', request })
		}
		const pendingIds = new Set(snapshot.pendingReviews.map((request) => request.requestId))
		if (
			[...active.reviews.values()].some(
				(request) => !request.resolved && !pendingIds.has(request.request.requestId),
			)
		)
			throw new HarnessSessionError(
				'reconciliation-required',
				'Native history did not prove the resolution of a recorded pending review.',
			)
		this.phase = [...active.reviews.values()].some((r) => !r.resolved) ? 'waiting' : 'running'
	}
	async close(): Promise<void> {
		if (this.phase === 'closed') return
		const release = this.reserve()
		try {
			if (this.connection) {
				await this.connection.close() // failure retains the exact cleanup authority and writer
				this.connection = undefined
				++this.epoch
			}
			await this.events
			if (this.active && !(await this.journal.log.activeTurn())) {
				this.active.removeAbort?.()
				this.active.reject(
					new HarnessSessionError(
						'terminal-recorded',
						'The native terminal was recorded before its live notification failed.',
					),
				)
				this.active = undefined
			}
			if (this.active?.nativeTurn)
				await this.finish(this.active, {
					kind: 'turn-completed',
					...this.active.nativeTurn,
					status: 'cancelled',
				})
			else if (this.active) {
				this.active.removeAbort?.()
				this.active.reject(
					new HarnessSessionError(
						'reconciliation-required',
						'Unacknowledged dispatch remains unresolved in the durable log.',
					),
				)
				this.active = undefined
			}
			await this.journal.release()
			this.phase = 'closed'
		} finally {
			release()
		}
	}
}
