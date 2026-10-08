import { randomUUID } from 'node:crypto'
import type {
	HarnessAdapter,
	HarnessBinding,
	HarnessCapabilities,
	HarnessConnection,
	HarnessDecision,
	HarnessEvent,
	HarnessEventSink,
	HarnessHistorySnapshot,
	HarnessJson,
	HarnessModel,
	HarnessNativeTurn,
	HarnessPrompt,
	HarnessReviewRequest,
	ReasoningEffort,
} from '@namzu/sdk'
import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import {
	ClaudeTurnProjection,
	claudeJson,
	claudeLaunchArgs,
	claudeModels,
	claudePermissionMode,
	claudeRecord,
	claudeString,
} from './claude-protocol.js'
import { resolveHarnessExecutable } from './native-executable.js'
import {
	type HarnessProcess,
	type HarnessProcessOptions,
	type NativeHarnessCommand,
	startHarnessProcess,
} from './process.js'

const CONTROL_TIMEOUT_MS = 15_000
const CAPABILITIES: HarnessCapabilities = Object.freeze({
	persistentSessions: true,
	history: 'unavailable',
	models: 'discover',
	permissions: 'interactive',
	interrupt: 'native-terminal',
	attachments: Object.freeze([]),
	reviewModes: Object.freeze(['prompt', 'plan'] as const),
})

export interface ClaudeHarnessOptions {
	/** Stable host identity for the selected executable/state/account route; never a token. */
	readonly profileRef: string
	readonly executable?: string
	readonly env?: NodeJS.ProcessEnv
	/** Exact transport injection for protocol tests; production uses owned native processes. */
	readonly startProcess?: (
		command: NativeHarnessCommand,
		options: HarnessProcessOptions,
	) => HarnessProcess
	readonly resolveExecutable?: typeof resolveHarnessExecutable
}

type Control = {
	resolve(value: Record<string, unknown>): void
	reject(error: unknown): void
	cleanup(): void
}
type Active = {
	turn: HarnessNativeTurn
	projection: ClaudeTurnProjection
	started: boolean
	interrupting: boolean
	permissionMode: HarnessPrompt['permissionMode']
}

function equalJson(left: unknown, right: unknown): boolean {
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(stable)
		const record = claudeRecord(value)
		return record
			? Object.fromEntries(
					Object.keys(record)
						.sort()
						.map((key) => [key, stable(record[key])]),
				)
			: value
	}
	return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

class ClaudeWire {
	private process!: HarnessProcess
	private readonly pending = new Map<string, Control>()
	private stopped = false
	private closeOperation: Promise<{ readonly stopped: true }> | undefined
	constructor(
		private readonly onFrame: (frame: Record<string, unknown>) => Promise<void>,
		private readonly onClosed: (error?: Error) => Promise<void>,
	) {}
	start(
		command: NativeHarnessCommand,
		options: Omit<HarnessProcessOptions, 'onFrame' | 'onClosed'>,
		start: NonNullable<ClaudeHarnessOptions['startProcess']>,
	): void {
		this.process = start(command, {
			...options,
			onFrame: async (raw) => {
				const frame = claudeRecord(raw)
				if (!frame) throw new Error('The native engine emitted an invalid protocol frame.')
				if (frame.type === 'control_response') {
					const response = claudeRecord(frame.response)
					const id = claudeString(response?.request_id)
					const control = id ? this.pending.get(id) : undefined
					if (!id || !control) return
					this.pending.delete(id)
					control.cleanup()
					if (response?.subtype === 'success')
						control.resolve(claudeRecord(response.response) ?? {})
					else control.reject(new Error('The native engine refused a control operation.'))
					return
				}
				await this.onFrame(frame)
			},
			onClosed: async (error) => {
				this.stopped = true
				for (const control of this.pending.values()) {
					control.cleanup()
					control.reject(new Error('The native engine connection closed.'))
				}
				this.pending.clear()
				await this.onClosed(error)
			},
		})
	}
	write(frame: unknown): Promise<void> {
		if (this.stopped || this.closeOperation)
			return Promise.reject(new Error('The native engine connection is closed.'))
		return this.process.write(frame)
	}
	control(
		request: Record<string, HarnessJson>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		signal?.throwIfAborted()
		if (this.stopped || this.closeOperation)
			return Promise.reject(new Error('The native engine connection is closed.'))
		const id = randomUUID()
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(id)
				cleanup()
				reject(signal?.reason)
			}
			const timer = setTimeout(() => {
				this.pending.delete(id)
				cleanup()
				reject(new Error('The native engine control operation did not answer.'))
			}, CONTROL_TIMEOUT_MS)
			const cleanup = () => {
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
			}
			this.pending.set(id, { resolve, reject, cleanup })
			signal?.addEventListener('abort', abort, { once: true })
			if (signal?.aborted) {
				abort()
				return
			}
			void this.write({
				type: 'control_request',
				request_id: id,
				request,
			}).catch((error) => {
				if (!this.pending.delete(id)) return
				cleanup()
				reject(error)
			})
		})
	}
	close(): Promise<{ readonly stopped: true }> {
		if (!this.closeOperation) {
			this.closeOperation = this.process.close().catch((error) => {
				this.closeOperation = undefined
				throw error
			})
		}
		return this.closeOperation
	}
}

type Launch = {
	executable: string
	env: NodeJS.ProcessEnv
	cwd: string
	start: NonNullable<ClaudeHarnessOptions['startProcess']>
}

class ClaudeConnection implements HarnessConnection {
	capabilities: HarnessCapabilities = CAPABILITIES
	private wire: ClaudeWire
	private launch: Launch | undefined
	/** The level the running process was launched with; undefined means the engine default. */
	private effort: ReasoningEffort | undefined
	/** A native conversation exists to resume only after a turn was sent or when resuming. */
	private conversation: boolean
	private restarting = false
	private active: Active | undefined
	private submitting = false
	private closing = false
	private disconnected = false
	private configurationUncertain = false
	private model: string
	private permissionMode: HarnessPrompt['permissionMode'] = 'prompt'
	private readonly reviews = new Map<string, HarnessReviewRequest>()
	private readonly reviewHistory = new Map<string, HarnessReviewRequest>()
	private readonly answering = new Set<string>()
	private readonly uncertainAnswers = new Set<string>()
	private readonly priorItems = new Set<string>()
	private readonly priorResults = new Set<string>()
	private readonly operations = new Set<string>()
	private readonly backgroundTasks = new Set<string>()
	private sessionState: string | undefined
	private readonly snapshots: HarnessHistorySnapshot['events'][number][] = []

	constructor(
		readonly binding: HarnessBinding,
		private readonly sink: HarnessEventSink,
		initialModel: string,
		resumed: boolean,
	) {
		this.model = initialModel
		this.conversation = resumed
		this.wire = this.newWire()
	}
	private newWire(): ClaudeWire {
		const wire: ClaudeWire = new ClaudeWire(
			async (frame) => {
				// A replaced process can no longer speak for this conversation.
				if (wire === this.wire) await this.frame(frame)
			},
			async () => {
				if (wire !== this.wire || this.restarting) return
				this.disconnected = true
				await this.emit({
					kind: 'connection-lost',
					code: 'native-connection-closed',
					mayBeRunning: false,
				})
			},
		)
		return wire
	}
	start(launch: Launch): void {
		this.launch = launch
		this.wire.start(this.command(), { cwd: launch.cwd }, launch.start)
	}
	private command(): NativeHarnessCommand {
		const launch = this.launch as Launch
		return {
			executable: launch.executable,
			args: claudeLaunchArgs({
				model: this.model,
				...(this.effort ? { effort: this.effort } : {}),
				nativeSessionId: this.binding.nativeSessionId,
				resume: this.conversation,
			}),
			env: launch.env,
		}
	}
	/**
	 * Effort is a launch setting of the engine, so a different level needs a new process on the
	 * same native session. Only called between turns; the old process is confirmed stopped first.
	 */
	private async relaunch(model: string, effort: ReasoningEffort | undefined, signal?: AbortSignal) {
		const launch = this.launch as Launch
		const previous = { model: this.model, effort: this.effort }
		this.restarting = true
		try {
			await this.wire.close()
			this.wire = this.newWire()
			this.model = model
			this.effort = effort
			// The new process starts in supervised mode regardless of the old one.
			this.permissionMode = 'prompt'
			this.sessionState = undefined
			this.wire.start(this.command(), { cwd: launch.cwd }, launch.start)
			await this.initialize(signal)
		} catch (error) {
			this.model = previous.model
			this.effort = previous.effort
			this.configurationUncertain = true
			throw error
		} finally {
			this.restarting = false
		}
	}
	async initialize(signal?: AbortSignal): Promise<void> {
		const initialized = await this.wire.control({ subtype: 'initialize' }, signal)
		// Metadata is protocol availability, never successful inference/authentication.
		const models = Array.isArray(initialized.models)
			? claudeModels(initialized)
			: await this.models(signal)
		if (!models.some((model) => model.id === this.model))
			throw new Error('The selected model is not in the native engine catalogue.')
		this.offerEffort(models)
	}
	/** SDK admission reads the engine-wide levels; dispatch checks the chosen model's own row. */
	private offerEffort(models: readonly HarnessModel[]): void {
		this.capabilities = {
			...this.capabilities,
			effortLevels: [...new Set(models.flatMap((model) => model.effortLevels ?? []))],
		}
	}
	private async emit(event: HarnessEvent): Promise<void> {
		if (
			event.kind !== 'text-delta' &&
			event.kind !== 'tool-output' &&
			event.kind !== 'connection-lost'
		) {
			if (this.snapshots.length >= 50_000)
				throw new Error('The native session snapshot is too large.')
			this.snapshots.push(event)
		}
		await this.sink(event)
	}
	private assertConnected(): void {
		if (this.closing || this.disconnected)
			throw new Error('The native engine connection is closed.')
		if (this.configurationUncertain)
			throw new Error(
				'The native engine configuration outcome is unknown. Close this connection before continuing.',
			)
	}
	private sameTurn(turn: HarnessNativeTurn): boolean {
		return Boolean(
			this.active &&
				this.active.turn.nativeSessionId === turn.nativeSessionId &&
				this.active.turn.nativeTurnId === turn.nativeTurnId &&
				this.active.turn.turnIdSource === turn.turnIdSource,
		)
	}
	async models(signal?: AbortSignal): Promise<readonly HarnessModel[]> {
		this.assertConnected()
		const models = claudeModels(await this.wire.control({ subtype: 'list_models' }, signal))
		this.offerEffort(models)
		return models
	}
	async dispatch(supplied: HarnessPrompt): Promise<HarnessNativeTurn> {
		const input = Object.freeze({ ...supplied })
		this.assertConnected()
		input.signal?.throwIfAborted()
		if (
			this.active ||
			this.submitting ||
			this.backgroundTasks.size ||
			this.sessionState === 'running'
		)
			throw new Error(
				'The native engine is still working. Wait or stop it before sending another turn.',
			)
		if (
			!claudeString(input.operationId) ||
			!claudeString(input.model) ||
			typeof input.prompt !== 'string' ||
			input.prompt.length > 1_000_000
		)
			throw new Error('Invalid native engine prompt.')
		if (this.operations.has(input.operationId))
			throw new Error('A native engine prompt cannot be automatically replayed.')
		const mode = claudePermissionMode(input.permissionMode)
		this.submitting = true
		try {
			let restarted = false
			if (input.effort !== this.effort) {
				const row = (await this.models(input.signal)).find((model) => model.id === input.model)
				if (!row) throw new Error('The selected model is not in the native engine catalogue.')
				if (input.effort !== undefined && !row.effortLevels?.includes(input.effort))
					throw new Error('The selected native engine model does not offer this reasoning effort.')
				input.signal?.throwIfAborted()
				// The process is idle here: no active turn, no background work, no pending write.
				await this.relaunch(input.model, input.effort, input.signal)
				restarted = true
			} else if (input.effort !== undefined && input.model !== this.model) {
				const row = (await this.models(input.signal)).find((model) => model.id === input.model)
				if (row && !row.effortLevels?.includes(input.effort))
					throw new Error('The selected native engine model does not offer this reasoning effort.')
			}
			if (!restarted && input.model !== this.model) {
				if (!(await this.models(input.signal)).some((model) => model.id === input.model))
					throw new Error('The selected model is not in the native engine catalogue.')
				try {
					await this.wire.control({ subtype: 'set_model', model: input.model }, input.signal)
				} catch (error) {
					this.configurationUncertain = true
					throw error
				}
				this.model = input.model
			}
			if (input.permissionMode !== this.permissionMode) {
				try {
					await this.wire.control({ subtype: 'set_permission_mode', mode }, input.signal)
				} catch (error) {
					this.configurationUncertain = true
					throw error
				}
				this.permissionMode = input.permissionMode
			}
			input.signal?.throwIfAborted()
			this.assertConnected()
			const turn = Object.freeze({
				nativeSessionId: this.binding.nativeSessionId,
				nativeTurnId: input.operationId,
				turnIdSource: 'operation' as const,
			})
			const active: Active = {
				turn,
				projection: new ClaudeTurnProjection(turn, this.priorItems),
				started: false,
				interrupting: false,
				permissionMode: input.permissionMode,
			}
			this.active = active
			this.operations.add(input.operationId)
			this.conversation = true
			// State precedes the write: a terminal result may arrive before the write ACK.
			await this.wire.write({
				type: 'user',
				session_id: this.binding.nativeSessionId,
				parent_tool_use_id: null,
				message: { role: 'user', content: input.prompt },
			})
			return turn
		} finally {
			this.submitting = false
		}
	}
	async interrupt(turn: HarnessNativeTurn): Promise<{ readonly requested: true }> {
		this.assertConnected()
		if (!this.sameTurn(turn))
			throw new Error('This stop request does not belong to the current native turn.')
		const active = this.active as Active
		active.interrupting = true
		// The ACK confirms only delivery. The SDK waits for the actual correlated result/owned stop.
		await this.wire.control({ subtype: 'interrupt' })
		return { requested: true }
	}
	async respond(
		request: HarnessReviewRequest,
		decision: HarnessDecision,
	): Promise<{ readonly sent: true }> {
		this.assertConnected()
		const captured = this.reviews.get(request.requestId)
		if (
			!captured ||
			!this.sameTurn(request) ||
			!equalJson(captured, request) ||
			this.answering.has(request.requestId) ||
			this.uncertainAnswers.has(request.requestId) ||
			this.active?.interrupting
		)
			throw new Error('This native permission request is no longer current.')
		if (!captured.decisions.includes(decision.kind))
			throw new Error('This native permission decision is unsupported.')
		if (
			this.active?.permissionMode === 'plan' &&
			decision.kind === 'approve-once' &&
			captured.title === 'ExitPlanMode'
		)
			throw new Error('Change the current review mode before executing the native plan.')
		const response =
			decision.kind === 'approve-once'
				? {
						behavior: 'allow',
						updatedInput:
							decision.updatedInput === undefined
								? captured.input
								: claudeJson(decision.updatedInput),
					}
				: {
						behavior: 'deny',
						message: 'The operator declined this native tool request.',
						...(decision.kind === 'cancel' ? { interrupt: true } : {}),
					}
		if (decision.kind === 'approve-once' && !claudeRecord(response.updatedInput))
			throw new Error('The native tool input must be an object.')
		this.answering.add(request.requestId)
		try {
			await this.wire.write({
				type: 'control_response',
				response: {
					subtype: 'success',
					request_id: captured.requestId,
					response,
				},
			})
			if (this.reviews.get(request.requestId) === captured) {
				this.reviews.delete(request.requestId)
				await this.emit({
					nativeSessionId: captured.nativeSessionId,
					nativeTurnId: captured.nativeTurnId,
					turnIdSource: captured.turnIdSource,
					kind: 'review-resolved',
					requestId: captured.requestId,
				})
			}
			return { sent: true }
		} catch (error) {
			// An unconfirmed pipe write may already have authorized the native tool.
			this.uncertainAnswers.add(request.requestId)
			throw error
		} finally {
			this.answering.delete(request.requestId)
		}
	}
	async readHistory(signal?: AbortSignal): Promise<HarnessHistorySnapshot> {
		signal?.throwIfAborted()
		return {
			binding: this.binding,
			...(this.active ? { activeTurn: this.active.turn } : {}),
			events: [...this.snapshots],
			pendingReviews: [...this.reviews.values()],
			complete: false,
		}
	}
	async close(): Promise<{ readonly stopped: true }> {
		this.closing = true
		return this.wire.close()
	}
	private async frame(frame: Record<string, unknown>): Promise<void> {
		const parent = claudeString(frame.parent_tool_use_id)
		// Native subagent session identifiers never rebind the parent conversation.
		if (parent) return
		const session = claudeString(frame.session_id)
		if (session && session !== this.binding.nativeSessionId)
			throw new Error('The native engine changed its owned session identity.')
		if (
			['stream_event', 'assistant', 'user', 'result'].includes(String(frame.type)) &&
			session !== this.binding.nativeSessionId
		)
			throw new Error('The native engine omitted its owned session identity.')
		if (frame.type === 'system') {
			const task = claudeString(frame.task_id)
			if (frame.subtype === 'task_started' && task) this.backgroundTasks.add(task)
			if (
				frame.subtype === 'task_notification' &&
				task &&
				['completed', 'failed', 'stopped'].includes(String(frame.status))
			)
				this.backgroundTasks.delete(task)
			if (frame.subtype === 'session_state_changed')
				this.sessionState = claudeString(frame.session_state) ?? claudeString(frame.state)
		}
		if (frame.type === 'control_cancel_request') {
			const id = claudeString(frame.request_id)
			const captured = id ? this.reviews.get(id) : undefined
			if (id && captured) {
				this.reviews.delete(id)
				await this.emit({
					nativeSessionId: captured.nativeSessionId,
					nativeTurnId: captured.nativeTurnId,
					turnIdSource: captured.turnIdSource,
					kind: 'review-resolved',
					requestId: id,
				})
			}
			return
		}
		const active = this.active
		if (frame.type === 'control_request') {
			const request = claudeRecord(frame.request)
			const id = claudeString(frame.request_id)
			if (!id) throw new Error('The native engine emitted an invalid permission request.')
			const tool = claudeString(request?.tool_name)
			const item = claudeString(request?.tool_use_id)
			if (
				!active ||
				active.interrupting ||
				request?.subtype !== 'can_use_tool' ||
				!tool ||
				!item ||
				!claudeRecord(request.input)
			) {
				await this.wire.write({
					type: 'control_response',
					response: {
						subtype: 'error',
						request_id: id,
						error: 'This native callback is unavailable in the current operation.',
					},
				})
				return
			}
			const captured: HarnessReviewRequest = Object.freeze({
				...active.turn,
				requestId: id,
				nativeItemId: item,
				kind:
					tool === 'Bash'
						? 'command'
						: ['Write', 'Edit', 'MultiEdit'].includes(tool)
							? 'file-change'
							: 'tool',
				title: tool,
				input: claudeJson(request.input),
				decisions: Object.freeze(['approve-once', 'reject', 'cancel'] as const),
			})
			if (tool === 'AskUserQuestion') {
				await this.wire.write({
					type: 'control_response',
					response: {
						subtype: 'success',
						request_id: id,
						response: { behavior: 'deny', message: 'Answer this question in the conversation.' },
					},
				})
				return
			}
			const prior = this.reviews.get(id)
			if (prior) {
				if (!equalJson(prior, captured))
					throw new Error('The native engine reused a permission request identity.')
				return
			}
			if (this.reviewHistory.has(id))
				throw new Error('The native engine reused a resolved permission request identity.')
			this.reviews.set(id, captured)
			this.reviewHistory.set(id, captured)
			await this.started(active)
			await this.emit({ kind: 'review-requested', request: captured })
			return
		}
		if (!active || !['stream_event', 'assistant', 'user', 'result'].includes(String(frame.type)))
			return
		if (frame.type === 'result') {
			const id = claudeString(frame.uuid)
			if (!id) throw new Error('The native engine result omitted its stable identity.')
			if (this.priorResults.has(id)) return
			this.priorResults.add(id)
		}
		await this.started(active)
		for (const event of active.projection.consume(frame)) await this.emit(event)
		if (frame.type === 'result') {
			for (const id of active.projection.messages.keys()) this.priorItems.add(id)
			for (const id of active.projection.tools.keys()) this.priorItems.add(id)
			for (const request of this.reviews.values())
				await this.emit({
					...active.turn,
					kind: 'review-resolved',
					requestId: request.requestId,
				})
			this.reviews.clear()
			if (this.active === active) this.active = undefined
		}
	}
	private async started(active: Active): Promise<void> {
		if (active.started) return
		active.started = true
		await this.emit({
			...active.turn,
			kind: 'turn-started',
			model: this.model,
		})
	}
}

/** External engine identity stays separate from Namzu's borrowed provider credentials. */
export function createClaudeHarnessAdapter(options: ClaudeHarnessOptions): HarnessAdapter {
	const profileRef = claudeString(options.profileRef)
	if (!profileRef) throw new Error('A native engine profile identity is required.')
	const env = Object.freeze({
		...(options.env ?? process.env),
		CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
	})
	const resolveExecutable = options.resolveExecutable ?? resolveHarnessExecutable
	const start = options.startProcess ?? startHarnessProcess
	const executable = options.executable
	return Object.freeze({
		engineId: 'claude',
		profileRef,
		async open(input: Parameters<HarnessAdapter['open']>[0], onEvent: HarnessEventSink) {
			input.signal?.throwIfAborted()
			const cwd = canonicalProjectPath(input.cwd)
			const model = claudeString(input.model ?? input.resume?.initialModel)
			if (!model)
				throw new Error(
					'Choose a model from the native engine catalogue before starting this conversation.',
				)
			const resume = input.resume
			if (
				resume &&
				(resume.v !== 1 ||
					resume.engineId !== 'claude' ||
					resume.profileRef !== profileRef ||
					resume.cwd !== cwd ||
					!claudeString(resume.nativeSessionId))
			)
				throw new Error('The native engine continuation belongs to another profile or workspace.')
			const nativeSessionId = resume?.nativeSessionId ?? randomUUID()
			const binding: HarnessBinding = Object.freeze(
				resume
					? { ...resume }
					: {
							v: 1,
							engineId: 'claude',
							profileRef,
							cwd,
							nativeSessionId,
							initialModel: model,
						},
			)
			const command = await resolveExecutable('claude', {
				...(executable ? { executable } : {}),
				env,
			})
			input.signal?.throwIfAborted()
			const connection = new ClaudeConnection(binding, onEvent, model, Boolean(resume))
			connection.start({ executable: command, env, cwd, start })
			try {
				await connection.initialize(input.signal)
				return connection
			} catch (error) {
				try {
					await connection.close()
				} catch (closeError) {
					throw new AggregateError(
						[error, closeError],
						'The native engine could not initialize or confirm shutdown.',
					)
				}
				throw error
			}
		},
	})
}

/** Isolated real native metadata discovery; success is not proof of account authentication. */
export async function discoverClaudeHarnessModels(
	options: Omit<ClaudeHarnessOptions, 'profileRef'> & {
		readonly cwd: string
		readonly signal?: AbortSignal
	},
): Promise<readonly HarnessModel[]> {
	options.signal?.throwIfAborted()
	const cwd = canonicalProjectPath(options.cwd)
	const env = Object.freeze({ ...(options.env ?? process.env) })
	const executable = await (options.resolveExecutable ?? resolveHarnessExecutable)('claude', {
		...(options.executable ? { executable: options.executable } : {}),
		env,
	})
	options.signal?.throwIfAborted()
	const wire = new ClaudeWire(
		async (frame) => {
			if (frame.type === 'control_request') {
				const id = claudeString(frame.request_id)
				if (id)
					await wire.write({
						type: 'control_response',
						response: {
							subtype: 'error',
							request_id: id,
							error: 'Metadata discovery cannot authorize a native operation.',
						},
					})
			}
		},
		async () => {},
	)
	wire.start(
		{
			executable,
			args: claudeLaunchArgs({
				nativeSessionId: '',
				resume: false,
				metadata: true,
			}),
			env,
		},
		{ cwd },
		options.startProcess ?? startHarnessProcess,
	)
	try {
		const initial = await wire.control({ subtype: 'initialize' }, options.signal)
		const listed = await wire.control({ subtype: 'list_models' }, options.signal)
		return claudeModels(Array.isArray(listed.models) ? listed : initial)
	} finally {
		await wire.close()
	}
}
