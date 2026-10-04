import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type {
	HarnessAdapter,
	HarnessBinding,
	HarnessCapabilities,
	HarnessConnection,
	HarnessDecision,
	HarnessEvent,
	HarnessEventSink,
	HarnessHistorySnapshot,
	HarnessModel,
	HarnessNativeTurn,
	HarnessPrompt,
	HarnessReviewRequest,
	ReviewMode,
} from '@namzu/sdk'
import { CLI_VERSION } from '../../version.js'
import {
	codexItemEvents,
	codexJson,
	codexPermissionConfig,
	codexRecord,
	codexString,
	codexTerminalEvent,
	parseCodexModels,
} from './codex-protocol.js'
import { resolveHarnessExecutable } from './native-executable.js'
import { type HarnessProcess, startHarnessProcess } from './process.js'

export interface CodexHarnessAdapterOptions {
	readonly executable?: string
	readonly env?: NodeJS.ProcessEnv
	/** Host-owned profile identity; never an account token or renderer argument. */
	readonly profileRef?: string
}

type RpcId = string | number
class CodexRpcRefusal extends Error {
	readonly code = 'codex-rpc-refused'
}
interface PendingRpc {
	resolve(value: unknown): void
	reject(error: unknown): void
	clear(): void
}

class CodexWire {
	private sequence = 0
	private readonly pending = new Map<RpcId, PendingRpc>()
	readonly process: HarnessProcess
	private expectedClose = false
	constructor(
		executable: string,
		env: NodeJS.ProcessEnv,
		cwd: string,
		onNotification: (method: string, params: unknown) => Promise<void>,
		onRequest: (id: RpcId, method: string, params: unknown) => Promise<void>,
		onClosed: () => Promise<void>,
	) {
		this.process = startHarnessProcess(
			{ executable, args: ['app-server'], env },
			{
				cwd,
				onFrame: async (value) => {
					const frame = codexRecord(value)
					if (!frame) throw new Error('Codex emitted an invalid protocol envelope.')
					const id =
						typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : undefined
					if (typeof frame.method === 'string') {
						if (id !== undefined) await onRequest(id, frame.method, frame.params)
						else await onNotification(frame.method, frame.params)
					} else if (id !== undefined) {
						const pending = this.pending.get(id)
						if (!pending) return
						this.pending.delete(id)
						pending.clear()
						if (frame.error !== undefined)
							pending.reject(new CodexRpcRefusal('Codex refused the protocol request.'))
						else pending.resolve(frame.result)
					}
				},
				onClosed: async () => {
					for (const request of this.pending.values()) {
						request.clear()
						request.reject(new Error('Codex transport closed before the request completed.'))
					}
					this.pending.clear()
					if (!this.expectedClose) await onClosed()
				},
			},
		)
	}
	request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		signal?.throwIfAborted()
		const id = `namzu-codex-${++this.sequence}`
		return new Promise((resolveRequest, rejectRequest) => {
			const abort = () => finish(signal?.reason ?? new Error('Codex request was cancelled.'))
			const timer = setTimeout(() => finish(new Error('Codex request did not complete.')), 30_000)
			const finish = (error: unknown) => {
				const pending = this.pending.get(id)
				if (!pending) return
				this.pending.delete(id)
				pending.clear()
				rejectRequest(error)
			}
			this.pending.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				clear: () => {
					clearTimeout(timer)
					signal?.removeEventListener('abort', abort)
				},
			})
			signal?.addEventListener('abort', abort, { once: true })
			void this.process.write({ id, method, params }).catch(finish)
			if (signal?.aborted) abort()
		})
	}
	async initialize(signal?: AbortSignal): Promise<void> {
		await this.request(
			'initialize',
			{
				clientInfo: { name: 'namzu', title: 'Namzu', version: CLI_VERSION },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
			signal,
		)
		await this.process.write({ method: 'initialized' })
		const response = codexRecord(
			await this.request('account/read', { refreshToken: false }, signal),
		)
		if (!response || (response.requiresOpenaiAuth === true && !response.account))
			throw new Error('Codex CLI requires its own signed-in account.')
	}
	async models(signal?: AbortSignal): Promise<readonly HarnessModel[]> {
		const rows: unknown[] = []
		const seen = new Set<string>()
		let cursor: string | undefined
		do {
			const page = codexRecord(
				await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, signal),
			)
			if (!page || !Array.isArray(page.data))
				throw new Error('Codex returned an invalid model page.')
			rows.push(...page.data)
			cursor = codexString(page.nextCursor)
			if (cursor && seen.has(cursor)) throw new Error('Codex repeated a model pagination cursor.')
			if (cursor) seen.add(cursor)
		} while (cursor)
		return parseCodexModels(rows)
	}
	respond(id: RpcId, result: unknown): Promise<void> {
		return this.process.write({ id, result })
	}
	unsupported(id: RpcId): Promise<void> {
		return this.process.write({
			id,
			error: {
				code: -32601,
				message: 'This Codex request is unsupported by Namzu.',
			},
		})
	}
	close(): Promise<{ readonly stopped: true }> {
		this.expectedClose = true
		return this.process.close()
	}
}

interface PendingReview {
	readonly rpcId: RpcId
	readonly method: string
	readonly request: HarnessReviewRequest
	readonly params: Record<string, unknown>
}

function publicRequestId(id: RpcId): string {
	return `codex:${JSON.stringify([typeof id, id])}`
}

interface CompletedAnswer {
	readonly nativeItemId: string
	readonly explicit: boolean
}

function completedAnswer(
	previous: CompletedAnswer | undefined,
	event: HarnessEvent,
): CompletedAnswer | undefined {
	if (event.kind !== 'message-completed') return previous
	if (event.parts?.length && event.parts.every((part) => part.phase === 'commentary'))
		return previous
	const explicit = event.parts?.some((part) => part.phase === 'final_answer') ?? false
	// Older engines omit the phase. Their last completed assistant item is the
	// fallback, but it cannot displace an explicitly identified final answer.
	if (previous?.explicit && !explicit) return previous
	return { nativeItemId: event.nativeItemId, explicit }
}

class CodexConnection implements HarnessConnection {
	readonly capabilities: HarnessCapabilities = {
		persistentSessions: true,
		history: 'snapshot',
		models: 'discover',
		permissions: 'interactive',
		interrupt: 'native-terminal',
		attachments: [],
		reviewModes: ['prompt', 'accept-edits', 'auto', 'strict', 'plan'],
	}
	private bindingValue?: HarnessBinding
	private active?: HarnessNativeTurn
	private dispatching = false
	private dispatchTerminal = false
	private uncertain = false
	private closed = false
	private hasDispatched = false
	private permissionMode: ReviewMode = 'prompt'
	private readonly reasoning = new Map<string, string>()
	private readonly reviews = new Map<string, PendingReview>()
	private readonly early: (() => Promise<void>)[] = []
	private readonly emitted = new Set<string>()
	private readonly finalItems = new Map<string, CompletedAnswer>()
	private readonly wire: CodexWire
	constructor(
		executable: string,
		env: NodeJS.ProcessEnv,
		private readonly cwd: string,
		private readonly profileRef: string,
		private readonly sink: HarnessEventSink,
	) {
		this.wire = new CodexWire(
			executable,
			env,
			cwd,
			(method, params) => this.notification(method, params),
			(id, method, params) => this.serverRequest(id, method, params),
			async () => {
				this.closed = true
				await this.sink({
					kind: 'connection-lost',
					code: 'codex-transport-closed',
					mayBeRunning: this.dispatching || this.uncertain || this.active !== undefined,
				})
			},
		)
	}
	get binding(): HarnessBinding {
		if (!this.bindingValue) throw new Error('Codex thread binding is not established.')
		return this.bindingValue
	}
	async open(input: Parameters<HarnessAdapter['open']>[0]): Promise<this> {
		try {
			await this.wire.initialize(input.signal)
			const models = await this.models(input.signal)
			const model = input.model ?? input.resume?.initialModel ?? models[0]?.id
			if (!model || !models.some((row) => row.id === model))
				throw new Error('The selected model is unavailable in Codex CLI.')
			const resume = input.resume
			if (
				resume &&
				(resume.engineId !== 'codex' ||
					resume.profileRef !== this.profileRef ||
					resume.cwd !== this.cwd)
			)
				throw new Error(
					'Codex continuation does not belong to this execution profile and workspace.',
				)
			const response = codexRecord(
				await this.wire.request(
					resume ? 'thread/resume' : 'thread/start',
					{
						...(resume ? { threadId: resume.nativeSessionId, excludeTurns: true } : {}),
						cwd: this.cwd,
						model,
						approvalPolicy: 'untrusted',
						sandbox: 'read-only',
						approvalsReviewer: 'user',
					},
					input.signal,
				),
			)
			const thread = codexRecord(response?.thread)
			const nativeSessionId = codexString(thread?.id)
			const threadCwd = codexString(thread?.cwd)
			const confirmedModel = codexString(response?.model) ?? codexString(thread?.model)
			if (
				!nativeSessionId ||
				!threadCwd ||
				(await realpath(threadCwd)) !== this.cwd ||
				confirmedModel !== model ||
				(resume && nativeSessionId !== resume.nativeSessionId)
			)
				throw new Error('Codex returned an incompatible thread binding.')
			this.bindingValue = resume ?? {
				v: 1,
				engineId: 'codex',
				profileRef: this.profileRef,
				nativeSessionId,
				cwd: this.cwd,
				initialModel: confirmedModel,
			}
			this.hasDispatched = resume !== undefined
			for (const event of this.early.splice(0)) await event()
			if (resume) await this.readHistory(input.signal)
			return this
		} catch (error) {
			await this.wire.close()
			throw error
		}
	}
	models(signal?: AbortSignal): Promise<readonly HarnessModel[]> {
		return this.wire.models(signal)
	}
	private async emit(event: HarnessEvent): Promise<void> {
		if ('nativeSessionId' in event && event.nativeSessionId !== this.binding.nativeSessionId) return
		if (
			event.kind === 'message-started' ||
			event.kind === 'message-completed' ||
			event.kind === 'tool-started' ||
			event.kind === 'tool-completed' ||
			event.kind === 'turn-started' ||
			event.kind === 'turn-completed' ||
			event.kind === 'review-resolved'
		) {
			const key = `${event.kind}:${event.nativeTurnId}:${'nativeItemId' in event ? event.nativeItemId : event.kind === 'review-resolved' ? event.requestId : ''}`
			if (this.emitted.has(key)) return
			this.emitted.add(key)
		}
		if ('nativeTurnId' in event) {
			const answer = completedAnswer(this.finalItems.get(event.nativeTurnId), event)
			if (answer) this.finalItems.set(event.nativeTurnId, answer)
		}
		await this.sink(event)
	}
	private async notification(method: string, value: unknown): Promise<void> {
		if (!this.bindingValue) {
			this.early.push(() => this.notification(method, value))
			return
		}
		const params = codexRecord(value)
		if (!params || params.threadId !== this.binding.nativeSessionId) return
		const rawTurn = codexRecord(params.turn)
		const nativeTurnId = codexString(params.turnId) ?? codexString(rawTurn?.id)
		if (!nativeTurnId && method !== 'serverRequest/resolved') return
		const turn = {
			nativeSessionId: this.binding.nativeSessionId,
			nativeTurnId: nativeTurnId ?? '',
		}
		if (nativeTurnId && this.emitted.has(`turn-completed:${nativeTurnId}:`)) return
		if (method === 'turn/started') {
			this.active = turn
			await this.emit({ ...turn, kind: 'turn-started' })
		} else if (method === 'turn/completed') {
			const terminal = codexTerminalEvent(turn, rawTurn)
			if (!terminal) throw new Error('Codex emitted an invalid terminal turn.')
			const final = this.finalItems.get(turn.nativeTurnId)
			if (this.active?.nativeTurnId === nativeTurnId) {
				if (this.dispatching) this.dispatchTerminal = true
				this.active = undefined
			}
			this.uncertain = false
			this.reasoning.clear()
			for (const review of this.reviews.values()) {
				if (review.request.nativeTurnId === nativeTurnId) {
					this.reviews.delete(review.request.requestId)
					await this.emit({
						...turn,
						kind: 'review-resolved',
						requestId: review.request.requestId,
					})
				}
			}
			await this.emit({ ...terminal, ...(final ? { finalItemId: final.nativeItemId } : {}) })
			this.finalItems.delete(turn.nativeTurnId)
		} else if (method === 'item/started' || method === 'item/completed') {
			for (const event of codexItemEvents(turn, params.item, method === 'item/completed'))
				await this.emit(event)
		} else if (method === 'item/agentMessage/delta') {
			const nativeItemId = codexString(params.itemId)
			if (nativeItemId && typeof params.delta === 'string') {
				await this.emit({ ...turn, nativeItemId, kind: 'message-started' })
				await this.emit({
					...turn,
					nativeItemId,
					kind: 'text-delta',
					text: params.delta,
				})
			}
		} else if (method === 'item/reasoning/summaryTextDelta') {
			const nativeItemId = codexString(params.itemId)
			if (nativeItemId && typeof params.delta === 'string') {
				const blockId = `${nativeItemId}:${String(params.summaryIndex ?? 0)}`
				const text = (this.reasoning.get(blockId) ?? '') + params.delta
				this.reasoning.set(blockId, text)
				await this.emit({
					...turn,
					nativeItemId,
					kind: 'reasoning',
					blockId,
					status: 'pending',
					text,
				})
			}
		} else if (
			method === 'item/commandExecution/outputDelta' ||
			method === 'item/fileChange/outputDelta'
		) {
			const nativeItemId = codexString(params.itemId)
			if (nativeItemId && typeof params.delta === 'string')
				await this.emit({
					...turn,
					nativeItemId,
					kind: 'tool-output',
					text: params.delta,
				})
		} else if (method === 'serverRequest/resolved') {
			const id = params.requestId
			if (typeof id !== 'string' && typeof id !== 'number') return
			const requestId = publicRequestId(id)
			const review = this.reviews.get(requestId)
			if (!review) return
			this.reviews.delete(requestId)
			await this.emit({
				nativeSessionId: this.binding.nativeSessionId,
				nativeTurnId: review.request.nativeTurnId,
				kind: 'review-resolved',
				requestId,
			})
		}
	}
	private async serverRequest(id: RpcId, method: string, value: unknown): Promise<void> {
		if (!this.bindingValue) {
			this.early.push(() => this.serverRequest(id, method, value))
			return
		}
		const params = codexRecord(value)
		const turnId = codexString(params?.turnId)
		if (
			!params ||
			params.threadId !== this.binding.nativeSessionId ||
			!turnId ||
			![
				'item/commandExecution/requestApproval',
				'item/fileChange/requestApproval',
				'item/permissions/requestApproval',
				'item/tool/requestUserInput',
			].includes(method)
		) {
			await this.wire.unsupported(id)
			return
		}
		const command = method === 'item/commandExecution/requestApproval'
		const file = method === 'item/fileChange/requestApproval'
		if (
			this.emitted.has(`turn-completed:${turnId}:`) ||
			(this.active && this.active.nativeTurnId !== turnId)
		) {
			await this.wire.unsupported(id)
			return
		}
		if (!this.active) {
			this.active = {
				nativeSessionId: this.binding.nativeSessionId,
				nativeTurnId: turnId,
			}
			await this.emit({ ...this.active, kind: 'turn-started' })
		}
		if (method === 'item/tool/requestUserInput') {
			// ACP exposes permission decisions, not typed question answers. An approval
			// cannot supply answers: settle the native request without granting a tool.
			const identity = {
				...this.active,
				nativeItemId: `${codexString(params.itemId) ?? 'question'}:${publicRequestId(id)}`,
			}
			await this.emit({
				...identity,
				kind: 'tool-started',
				name: 'request_user_input',
				input: codexJson({ questions: params.questions }),
			})
			await this.wire.respond(id, { answers: {} })
			await this.emit({
				...identity,
				kind: 'tool-completed',
				name: 'request_user_input',
				result: 'Answer this question in the conversation.',
				status: 'declined',
			})
			return
		}
		const request: HarnessReviewRequest = {
			nativeSessionId: this.binding.nativeSessionId,
			nativeTurnId: turnId,
			requestId: publicRequestId(id),
			nativeItemId: codexString(params.itemId),
			kind: command ? 'command' : file ? 'file-change' : 'tool',
			title: command
				? 'Approve Codex command'
				: file
					? 'Approve Codex file changes'
					: 'Approve Codex permissions',
			input: codexJson(
				command
					? { command: params.command, cwd: params.cwd, reason: params.reason }
					: file
						? { reason: params.reason, grantRoot: params.grantRoot }
						: { permissions: params.permissions, reason: params.reason },
			),
			decisions: ['approve-once', 'reject', 'cancel'],
		}
		this.reviews.set(request.requestId, { rpcId: id, method, request, params })
		if (['auto', 'strict', 'plan'].includes(this.permissionMode)) {
			await this.respond(request, {
				kind: this.permissionMode === 'auto' ? 'approve-once' : 'reject',
			})
			return
		}
		await this.sink({ kind: 'review-requested', request })
	}
	async dispatch(input: HarnessPrompt): Promise<HarnessNativeTurn> {
		if (this.closed || this.active || this.dispatching || this.uncertain || this.reviews.size > 0)
			throw new Error('Codex already has active or unresolved work.')
		input.signal?.throwIfAborted()
		this.dispatching = true
		let sent = false
		try {
			const model = (await this.models(input.signal)).find((row) => row.id === input.model)
			if (!model) throw new Error('The selected Codex model or effort is unavailable.')
			// Codex retains turn overrides on the thread. Omitting effort would retain an
			// earlier explicit value, including after switching to another model.
			const effort = input.effort ?? model.defaultEffort
			if (effort === undefined)
				throw new Error(
					'The selected Codex model does not report a default reasoning effort. Select an available effort explicitly.',
				)
			if (!model.effortLevels?.includes(effort))
				throw new Error('The selected Codex model or effort is unavailable.')
			if (!this.capabilities.reviewModes.includes(input.permissionMode))
				throw new Error('Codex does not support this permission mode.')
			this.permissionMode = input.permissionMode
			this.dispatchTerminal = false
			this.hasDispatched = true
			sent = true
			const response = codexRecord(
				await this.wire.request(
					'turn/start',
					{
						threadId: this.binding.nativeSessionId,
						clientUserMessageId: input.operationId,
						input: [{ type: 'text', text: input.prompt, text_elements: [] }],
						model: input.model,
						effort,
						...codexPermissionConfig(input.permissionMode, this.cwd),
						approvalsReviewer: 'user',
					},
					input.signal,
				),
			)
			const turn = codexRecord(response?.turn)
			const nativeTurnId = codexString(turn?.id)
			if (!nativeTurnId) throw new Error('Codex did not acknowledge a native turn identity.')
			const identity = {
				nativeSessionId: this.binding.nativeSessionId,
				nativeTurnId,
			}
			if (!this.emitted.has(`turn-completed:${nativeTurnId}:`)) {
				this.active = identity
				await this.emit({
					...identity,
					kind: 'turn-started',
					model: input.model,
				})
			}
			return identity
		} catch (error) {
			if (sent && !this.dispatchTerminal && !(error instanceof CodexRpcRefusal))
				this.uncertain = true
			throw error
		} finally {
			this.dispatching = false
		}
	}
	async interrupt(turn: HarnessNativeTurn): Promise<{ readonly requested: true }> {
		if (
			turn.nativeSessionId !== this.binding.nativeSessionId ||
			this.active?.nativeTurnId !== turn.nativeTurnId
		)
			throw new Error('Codex Stop no longer identifies the active turn.')
		await this.wire.request('turn/interrupt', {
			threadId: turn.nativeSessionId,
			turnId: turn.nativeTurnId,
		})
		return { requested: true }
	}
	async respond(
		request: HarnessReviewRequest,
		decision: HarnessDecision,
	): Promise<{ readonly sent: true }> {
		const pending = this.reviews.get(request.requestId)
		if (!pending || JSON.stringify(pending.request) !== JSON.stringify(request))
			throw new Error('The Codex approval request is stale or changed.')
		if (decision.kind === 'approve-once' && decision.updatedInput !== undefined)
			throw new Error('Codex cannot edit an approval operation.')
		const result =
			pending.method === 'item/permissions/requestApproval'
				? {
						permissions: decision.kind === 'approve-once' ? pending.params.permissions : {},
						scope: 'turn',
					}
				: {
						decision:
							decision.kind === 'approve-once'
								? 'accept'
								: decision.kind === 'cancel'
									? 'cancel'
									: 'decline',
					}
		await this.wire.respond(pending.rpcId, result)
		this.reviews.delete(request.requestId)
		await this.emit({
			nativeSessionId: request.nativeSessionId,
			nativeTurnId: request.nativeTurnId,
			kind: 'review-resolved',
			requestId: request.requestId,
		})
		return { sent: true }
	}
	async readHistory(signal?: AbortSignal): Promise<HarnessHistorySnapshot> {
		if (!this.hasDispatched && !this.active)
			return {
				binding: this.binding,
				events: [],
				pendingReviews: [],
				complete: true,
			}
		const meta = codexRecord(
			await this.wire.request(
				'thread/read',
				{ threadId: this.binding.nativeSessionId, includeTurns: false },
				signal,
			),
		)
		const thread = codexRecord(meta?.thread)
		if (
			!thread ||
			thread.id !== this.binding.nativeSessionId ||
			typeof thread.cwd !== 'string' ||
			(await realpath(thread.cwd)) !== this.cwd
		)
			throw new Error('Codex history does not match its owned workspace.')
		const events: HarnessHistorySnapshot['events'][number][] = []
		let activeTurn: HarnessNativeTurn | undefined
		const pages = async (method: string, params: Record<string, unknown>): Promise<unknown[]> => {
			const values: unknown[] = []
			const seen = new Set<string>()
			let cursor: string | undefined
			do {
				const page = codexRecord(
					await this.wire.request(
						method,
						{
							...params,
							limit: 100,
							sortDirection: 'asc',
							...(cursor ? { cursor } : {}),
						},
						signal,
					),
				)
				if (!page || !Array.isArray(page.data)) throw new Error('Codex history page is invalid.')
				values.push(...page.data)
				cursor = codexString(page.nextCursor)
				if (cursor && seen.has(cursor))
					throw new Error('Codex history pagination repeated a cursor.')
				if (cursor) seen.add(cursor)
			} while (cursor)
			return values
		}
		const turns = await pages('thread/turns/list', {
			threadId: this.binding.nativeSessionId,
			itemsView: 'notLoaded',
		})
		for (const raw of turns) {
			const native = codexRecord(raw)
			const nativeTurnId = codexString(native?.id)
			if (!native || !nativeTurnId) throw new Error('Codex history turn identity is invalid.')
			const turn = {
				nativeSessionId: this.binding.nativeSessionId,
				nativeTurnId,
			}
			events.push({ ...turn, kind: 'turn-started' })
			let final: CompletedAnswer | undefined
			const items = await pages('thread/items/list', {
				threadId: turn.nativeSessionId,
				turnId: nativeTurnId,
			})
			for (const entry of items) {
				const item = codexRecord(entry)
				if (!item || item.turnId !== nativeTurnId)
					throw new Error('Codex history item belongs to another turn.')
				const rawItem = codexRecord(item.item)
				const completedItem =
					native.status !== 'inProgress' ||
					(rawItem?.status !== 'inProgress' &&
						rawItem?.type !== 'agentMessage' &&
						rawItem?.type !== 'reasoning')
				for (const event of [
					...codexItemEvents(turn, item.item, false),
					...(completedItem ? codexItemEvents(turn, item.item, true) : []),
				]) {
					final = completedAnswer(final, event)
					if (
						event.kind !== 'text-delta' &&
						event.kind !== 'tool-output' &&
						event.kind !== 'connection-lost'
					)
						events.push(event)
				}
			}
			const terminal = codexTerminalEvent(turn, native)
			if (terminal?.kind === 'turn-completed')
				events.push({ ...terminal, ...(final ? { finalItemId: final.nativeItemId } : {}) })
			else if (native.status === 'inProgress') activeTurn = turn
			else throw new Error('Codex history turn status is invalid.')
		}
		this.active = activeTurn
		const status = codexRecord(thread.status)
		const missingReviews =
			Array.isArray(status?.activeFlags) &&
			status.activeFlags.some(
				(flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
			) &&
			this.reviews.size === 0
		const complete =
			!missingReviews &&
			['idle', 'active'].includes(String(status?.type)) &&
			(status?.type !== 'active' || activeTurn !== undefined)
		if (complete) this.uncertain = false
		return {
			binding: this.binding,
			events,
			pendingReviews: [...this.reviews.values()].map((review) => review.request),
			...(activeTurn ? { activeTurn } : {}),
			complete,
		}
	}
	async close(): Promise<{ readonly stopped: true }> {
		const result = await this.wire.close()
		this.closed = true
		return result
	}
}

export async function createCodexHarnessAdapter(
	options: CodexHarnessAdapterOptions = {},
): Promise<HarnessAdapter> {
	const env = { ...process.env, ...options.env }
	const executable = await resolveHarnessExecutable('codex', {
		executable: options.executable,
		env,
	})
	if (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME))
		throw new Error('CODEX_HOME must be an absolute directory for native engine sessions.')
	const stateHome = resolve(env.CODEX_HOME ?? join(homedir(), '.codex'))
	const profileRef =
		options.profileRef ??
		`codex:${createHash('sha256').update(`${executable}\0${stateHome}`).digest('hex')}`
	return {
		engineId: 'codex',
		profileRef,
		async open(input, onEvent) {
			input.signal?.throwIfAborted()
			const cwd = await realpath(input.cwd)
			return new CodexConnection(executable, env, cwd, profileRef, onEvent).open({ ...input, cwd })
		},
	}
}

/** Engine-owned discovery never creates a Namzu or Codex conversation. */
export async function discoverCodexHarnessModels(
	options: CodexHarnessAdapterOptions & {
		readonly cwd: string
		readonly signal?: AbortSignal
	},
): Promise<readonly HarnessModel[]> {
	const env = { ...process.env, ...options.env }
	const executable = await resolveHarnessExecutable('codex', {
		executable: options.executable,
		env,
	})
	const wire: CodexWire = new CodexWire(
		executable,
		env,
		await realpath(options.cwd),
		async () => undefined,
		async (id): Promise<void> => wire.unsupported(id),
		async () => undefined,
	)
	try {
		await wire.initialize(options.signal)
		return await wire.models(options.signal)
	} finally {
		await wire.close()
	}
}
