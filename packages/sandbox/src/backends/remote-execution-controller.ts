import type { SandboxExecOptions, SandboxExecResult } from '@namzu/sdk'

const CONTROL_REQUEST_TIMEOUT_MS = 2_000
const CANCEL_CONFIRM_TIMEOUT_MS = 8_000
const RESULT_DRAIN_TIMEOUT_MS = 1_500
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1_000
const EXECUTION_OBSERVATION_GRACE_MS = 500
const MAX_TIMER_DELAY_MS = 2_147_483_647
const EXECUTION_ID_PATTERN =
	/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Exact wire version implemented by the shipped worker and microVM guest. */
export const REMOTE_EXECUTION_PROTOCOL_VERSION = 2 as const

export interface RemoteReservation {
	readonly ok: true
	readonly protocolVersion: typeof REMOTE_EXECUTION_PROTOCOL_VERSION
	readonly executionId: string
	readonly leaseExpiresAt: number
}

export interface RemoteTerminalMetadata {
	readonly exitCode: number
	readonly timedOut: boolean
	readonly durationMs: number
	readonly signal?: string
	readonly stdoutTruncated?: boolean
	readonly stderrTruncated?: boolean
}

export interface RemoteCancellationAcknowledgement {
	readonly ok: true
	readonly state: 'cancelled' | 'completed' | 'failed'
	readonly started: boolean
	readonly result?: RemoteTerminalMetadata
	readonly error?: string
}

export class RemoteCommandError extends Error {}

export class RemoteProtocolError extends Error {}

export interface SandboxRetirementObservation {
	readonly accepted: boolean
	readonly error?: Error
}

export class RemoteCancellationUnknownError extends Error {
	retirement?: SandboxRetirementObservation

	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'RemoteCancellationUnknownError'
	}
}

export class RemoteResultIncompleteError extends Error {
	constructor(
		message: string,
		readonly acknowledgement: RemoteCancellationAcknowledgement,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'RemoteResultIncompleteError'
	}
}

export interface RemoteExecutionAdapter<Context = undefined> {
	readonly label: string
	reserve(signal: AbortSignal): Promise<unknown>
	cancel(executionId: string, signal: AbortSignal): Promise<unknown>
	execute(
		executionId: string | undefined,
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
		transportSignal: AbortSignal,
		context: Context | undefined,
	): Promise<SandboxExecResult>
}

export interface RemoteExecutionControllerOptions {
	readonly controlRequestTimeoutMs?: number
	readonly cancelConfirmTimeoutMs?: number
	readonly resultDrainTimeoutMs?: number
	readonly executionObservationGraceMs?: number
	readonly defaultExecutionTimeoutMs?: number
}

function isTerminalMetadata(value: unknown): value is RemoteTerminalMetadata {
	if (!value || typeof value !== 'object') return false
	const metadata = value as Record<string, unknown>
	return (
		Number.isFinite(metadata.exitCode) &&
		typeof metadata.timedOut === 'boolean' &&
		Number.isFinite(metadata.durationMs) &&
		(metadata.signal === undefined || typeof metadata.signal === 'string') &&
		(metadata.stdoutTruncated === undefined || typeof metadata.stdoutTruncated === 'boolean') &&
		(metadata.stderrTruncated === undefined || typeof metadata.stderrTruncated === 'boolean')
	)
}

function parseReservation(value: unknown): RemoteReservation {
	if (!value || typeof value !== 'object') {
		throw new RemoteProtocolError('remote sandbox returned an invalid execution reservation')
	}
	const reservation = value as Record<string, unknown>
	if (
		reservation.ok !== true ||
		reservation.protocolVersion !== REMOTE_EXECUTION_PROTOCOL_VERSION ||
		!EXECUTION_ID_PATTERN.test(String(reservation.executionId ?? '')) ||
		!Number.isFinite(reservation.leaseExpiresAt)
	) {
		throw new RemoteProtocolError('remote sandbox returned an invalid execution reservation')
	}
	return reservation as unknown as RemoteReservation
}

function parseCancellation(value: unknown): RemoteCancellationAcknowledgement {
	if (!value || typeof value !== 'object') {
		throw new RemoteProtocolError('remote sandbox returned an invalid cancellation acknowledgement')
	}
	const acknowledgement = value as Record<string, unknown>
	if (
		acknowledgement.ok !== true ||
		!['cancelled', 'completed', 'failed'].includes(String(acknowledgement.state ?? '')) ||
		typeof acknowledgement.started !== 'boolean' ||
		(acknowledgement.result !== undefined && !isTerminalMetadata(acknowledgement.result)) ||
		(acknowledgement.error !== undefined && typeof acknowledgement.error !== 'string')
	) {
		throw new RemoteProtocolError('remote sandbox returned an invalid cancellation acknowledgement')
	}
	return acknowledgement as unknown as RemoteCancellationAcknowledgement
}

function cancelledBeforeStart(startedAt: number): SandboxExecResult {
	return {
		exitCode: 1,
		stdout: '',
		stderr: '',
		timedOut: false,
		durationMs: Math.max(0, Date.now() - startedAt),
		stdoutTruncated: false,
		stderrTruncated: false,
	}
}

function resultFromAcknowledgement(
	acknowledgement: RemoteCancellationAcknowledgement,
	startedAt: number,
): SandboxExecResult {
	const result = acknowledgement.result
	if (!result) return cancelledBeforeStart(startedAt)
	return { ...result, stdout: '', stderr: '' }
}

function resultIncomplete(
	error: unknown,
	acknowledgement: RemoteCancellationAcknowledgement,
): RemoteResultIncompleteError {
	const message = error instanceof Error ? error.message : String(error)
	return new RemoteResultIncompleteError(
		`Remote sandbox termination was confirmed (${acknowledgement.state}), but the terminal result/output stream was incomplete: ${message}. Do not infer complete output.`,
		acknowledgement,
		{ cause: error },
	)
}

function cancellationUnknown(error: unknown): RemoteCancellationUnknownError {
	const message = error instanceof Error ? error.message : String(error)
	return new RemoteCancellationUnknownError(
		`Remote sandbox cancellation could not be confirmed: ${message}. The remote outcome is unknown; do not automatically retry the command.`,
		{ cause: error },
	)
}

function observationDeadlineMs(
	timeout: number | undefined,
	defaultTimeoutMs: number,
	graceMs: number,
): number {
	const requested =
		typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
			? timeout
			: defaultTimeoutMs
	return Math.min(MAX_TIMER_DELAY_MS, requested + graceMs)
}

async function bounded<T>(
	label: string,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
	callerSignal?: AbortSignal,
): Promise<T> {
	callerSignal?.throwIfAborted()
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let removeAbort: (() => void) | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${label} exceeded ${timeoutMs}ms`)
			controller.abort(error)
			reject(error)
		}, timeoutMs)
	})
	const callerAbort = callerSignal
		? new Promise<never>((_, reject) => {
				const abort = () => {
					controller.abort(callerSignal.reason)
					reject(callerSignal.reason)
				}
				removeAbort = () => callerSignal.removeEventListener('abort', abort)
				if (callerSignal.aborted) abort()
				else callerSignal.addEventListener('abort', abort, { once: true })
			})
		: undefined
	try {
		const pending = operation(controller.signal)
		return await Promise.race([pending, timeout, ...(callerAbort ? [callerAbort] : [])])
	} finally {
		if (timer) clearTimeout(timer)
		removeAbort?.()
		controller.abort()
	}
}

/**
 * One state machine for remote command ownership. Every supported peer reserves
 * every command before admission, even when the caller supplied no signal, so
 * transport loss can be reconciled by identity. An old peer is refused; an
 * identity-less remote command is never started.
 */
export class RemoteExecutionController<Context = undefined> {
	private readonly controlRequestTimeoutMs: number
	private readonly cancelConfirmTimeoutMs: number
	private readonly resultDrainTimeoutMs: number
	private readonly executionObservationGraceMs: number
	private readonly defaultExecutionTimeoutMs: number

	constructor(
		private readonly adapter: RemoteExecutionAdapter<Context>,
		options: RemoteExecutionControllerOptions = {},
	) {
		this.controlRequestTimeoutMs = options.controlRequestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS
		this.cancelConfirmTimeoutMs = options.cancelConfirmTimeoutMs ?? CANCEL_CONFIRM_TIMEOUT_MS
		this.resultDrainTimeoutMs = options.resultDrainTimeoutMs ?? RESULT_DRAIN_TIMEOUT_MS
		this.executionObservationGraceMs =
			options.executionObservationGraceMs ?? EXECUTION_OBSERVATION_GRACE_MS
		this.defaultExecutionTimeoutMs =
			options.defaultExecutionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
	}

	async exec(
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
		context?: Context,
	): Promise<SandboxExecResult> {
		const startedAt = Date.now()
		if (opts?.signal?.aborted) return cancelledBeforeStart(startedAt)

		let reservation: RemoteReservation
		try {
			reservation = parseReservation(
				await bounded(
					`${this.adapter.label} execution reservation`,
					this.controlRequestTimeoutMs,
					(signal) => this.adapter.reserve(signal),
					opts?.signal,
				),
			)
		} catch (error) {
			if (opts?.signal?.aborted) return cancelledBeforeStart(startedAt)
			throw error
		}

		return await this.executeReserved(reservation, command, argv, opts, startedAt, context)
	}

	private async requestCancellation(
		executionId: string,
	): Promise<RemoteCancellationAcknowledgement> {
		const deadlineAt = Date.now() + this.cancelConfirmTimeoutMs
		let lastError: unknown = new Error('no cancellation attempt completed')
		while (Date.now() < deadlineAt) {
			const remaining = deadlineAt - Date.now()
			try {
				return parseCancellation(
					await bounded(
						`${this.adapter.label} cancellation attempt`,
						Math.min(this.controlRequestTimeoutMs, remaining),
						(signal) => this.adapter.cancel(executionId, signal),
					),
				)
			} catch (error) {
				lastError = error
				const delayMs = Math.min(50, deadlineAt - Date.now())
				if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
		}
		throw cancellationUnknown(lastError)
	}

	private async drainConfirmedExecution(
		pending: Promise<SandboxExecResult>,
		cancelled: RemoteCancellationAcknowledgement,
		startedAt: number,
	): Promise<SandboxExecResult> {
		if (!cancelled.started) return resultFromAcknowledgement(cancelled, startedAt)
		try {
			return await bounded(
				`${this.adapter.label} terminal-result drain`,
				this.resultDrainTimeoutMs,
				async () => await pending,
			)
		} catch (error) {
			if (error instanceof RemoteCommandError && cancelled.state === 'failed') throw error
			throw resultIncomplete(error, cancelled)
		}
	}

	private async executeReserved(
		reservation: RemoteReservation,
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
		startedAt: number,
		context: Context | undefined,
	): Promise<SandboxExecResult> {
		if (opts?.signal?.aborted) {
			const cancelled = await this.requestCancellation(reservation.executionId)
			if (cancelled.started) {
				throw resultIncomplete(
					new Error('the peer reported an admitted command before execute was sent'),
					cancelled,
				)
			}
			return resultFromAcknowledgement(cancelled, startedAt)
		}

		type CancellationReason = 'caller' | 'observation-timeout' | 'reconcile'
		let cancellationReason: CancellationReason | undefined
		let startCancellation: ((reason: CancellationReason) => void) | undefined
		const cancellation = new Promise<RemoteCancellationAcknowledgement>((resolve, reject) => {
			let started = false
			startCancellation = (reason) => {
				if (started) return
				started = true
				cancellationReason = reason
				void this.requestCancellation(reservation.executionId).then(resolve, reject)
			}
		})
		const onAbort = () => startCancellation?.('caller')
		opts?.signal?.addEventListener('abort', onAbort, { once: true })
		if (opts?.signal?.aborted) onAbort()
		const observationTimer = setTimeout(
			() => startCancellation?.('observation-timeout'),
			observationDeadlineMs(
				opts?.timeout,
				this.defaultExecutionTimeoutMs,
				this.executionObservationGraceMs,
			),
		)
		observationTimer.unref?.()

		const executionTransport = new AbortController()
		const execution = this.adapter.execute(
			reservation.executionId,
			command,
			argv,
			opts,
			executionTransport.signal,
			context,
		)
		const observedExecution = execution.then(
			(result) => ({ kind: 'result' as const, result }),
			(error: unknown) => ({ kind: 'error' as const, error }),
		)
		const observedCancellation = cancellation.then(
			(result) => ({ kind: 'cancelled' as const, result }),
			(error: unknown) => ({ kind: 'cancel-error' as const, error }),
		)

		try {
			const first = await Promise.race([observedExecution, observedCancellation])
			if (first.kind === 'result') return first.result
			if (first.kind === 'cancel-error') throw first.error
			if (first.kind === 'cancelled') {
				const result = await this.drainConfirmedExecution(execution, first.result, startedAt)
				return cancellationReason === 'observation-timeout' && first.result.state === 'cancelled'
					? { ...result, timedOut: true }
					: result
			}

			startCancellation?.('reconcile')
			let confirmed: RemoteCancellationAcknowledgement
			try {
				confirmed = await cancellation
			} catch (cancelError) {
				throw cancellationUnknown(cancelError)
			}
			if (first.error instanceof RemoteCommandError && confirmed.state === 'failed') {
				throw first.error
			}
			if (opts?.signal?.aborted && confirmed.state === 'cancelled' && !confirmed.started) {
				return resultFromAcknowledgement(confirmed, startedAt)
			}
			if (!confirmed.started) throw first.error
			throw resultIncomplete(first.error, confirmed)
		} finally {
			clearTimeout(observationTimer)
			opts?.signal?.removeEventListener('abort', onAbort)
			executionTransport.abort(new Error('remote sandbox execution observation finished'))
		}
	}
}
