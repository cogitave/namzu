import { type SandboxExecOptions, type SandboxExecResult, withHint } from '@namzu/sdk'

const CONTROL_REQUEST_TIMEOUT_MS = 2_000
const CANCEL_CONFIRM_TIMEOUT_MS = 8_000
const RESULT_DRAIN_TIMEOUT_MS = 1_500
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1_000
const EXECUTION_OBSERVATION_GRACE_MS = 500
const MAX_TIMER_DELAY_MS = 2_147_483_647
const EXECUTION_ID_PATTERN = /^exec_[0-9a-f-]{36}$/

interface ReserveResponse {
	readonly ok: true
	readonly protocolVersion: 2
	readonly executionId: string
	readonly leaseExpiresAt: number
}

interface TerminalMetadata {
	readonly exitCode: number
	readonly timedOut: boolean
	readonly durationMs: number
	readonly signal?: string
	readonly stdoutTruncated?: boolean
	readonly stderrTruncated?: boolean
}

interface CancelResponse {
	readonly ok: true
	readonly state: 'cancelled' | 'completed' | 'failed'
	readonly started: boolean
	readonly result?: TerminalMetadata
	readonly error?: string
}

type WorkerEvent =
	| { readonly type: 'stdout_delta'; readonly data: string }
	| { readonly type: 'stderr_delta'; readonly data: string }
	| ({ readonly type: 'result' } & TerminalMetadata)
	| { readonly type: 'error'; readonly error: string }

class WorkerExecutionError extends Error {}

class WorkerProtocolError extends Error {}

interface OutputState {
	stdout: string
	stderr: string
}

function isTerminalMetadata(value: unknown): value is TerminalMetadata {
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

function isTerminalEvent(value: unknown): value is Extract<WorkerEvent, { type: 'result' }> {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		(value as Record<string, unknown>).type === 'result' &&
		isTerminalMetadata(value)
	)
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

function resultIncomplete(error: unknown, acknowledgement: CancelResponse): Error {
	const message = error instanceof Error ? error.message : String(error)
	return Object.assign(
		new Error(
			`Remote sandbox termination was confirmed (${acknowledgement.state}), but the terminal result/output stream was incomplete: ${message}. Do not infer complete output.`,
			{ cause: error },
		),
		{ acknowledgement },
	)
}

function observationDeadlineMs(timeout: number | undefined): number {
	const requested =
		typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
			? timeout
			: DEFAULT_EXECUTION_TIMEOUT_MS
	return Math.min(MAX_TIMER_DELAY_MS, requested + EXECUTION_OBSERVATION_GRACE_MS)
}

function cancellationUnknown(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error)
	return new Error(
		`Remote sandbox cancellation could not be confirmed: ${message}. The remote outcome is unknown; do not automatically retry the command.`,
		{ cause: error },
	)
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

async function reserveExecution(baseUrl: string, signal: AbortSignal): Promise<string> {
	return await bounded(
		'sandbox execution reservation',
		CONTROL_REQUEST_TIMEOUT_MS,
		async (requestSignal) => {
			const response = await fetch(`${baseUrl}/executions/reserve`, {
				method: 'POST',
				signal: requestSignal,
			})
			if (response.status === 404) {
				throw new Error(
					'This sandbox worker does not support the execution-cancellation lease protocol. Rebuild the worker image or standby-pool profile before passing SandboxExecOptions.signal; refusing rather than pretending cancellation is active.',
				)
			}
			if (!response.ok) {
				throw new Error(
					`execution reservation failed: HTTP ${response.status} ${await response.text()}`,
				)
			}
			const body = (await response.json()) as Partial<ReserveResponse>
			if (
				body.ok !== true ||
				body.protocolVersion !== 2 ||
				!EXECUTION_ID_PATTERN.test(body.executionId ?? '') ||
				!Number.isFinite(body.leaseExpiresAt)
			) {
				throw new WorkerProtocolError('worker returned an invalid execution reservation')
			}
			return body.executionId as string
		},
		signal,
	)
}

async function requestCancellation(baseUrl: string, executionId: string): Promise<CancelResponse> {
	const deadlineAt = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
	let lastError: unknown = new Error('no cancellation attempt completed')
	while (Date.now() < deadlineAt) {
		const remaining = deadlineAt - Date.now()
		try {
			return await bounded(
				'sandbox cancellation attempt',
				Math.min(CONTROL_REQUEST_TIMEOUT_MS, remaining),
				async (signal) => {
					const response = await fetch(`${baseUrl}/cancel`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ executionId }),
						signal,
					})
					if (!response.ok) {
						throw new Error(`cancel failed: HTTP ${response.status} ${await response.text()}`)
					}
					const body = (await response.json()) as Partial<CancelResponse>
					if (
						body.ok !== true ||
						!['cancelled', 'completed', 'failed'].includes(body.state ?? '') ||
						typeof body.started !== 'boolean' ||
						(body.result !== undefined && !isTerminalMetadata(body.result)) ||
						(body.error !== undefined && typeof body.error !== 'string')
					) {
						throw new WorkerProtocolError('worker returned an invalid cancellation acknowledgement')
					}
					return body as CancelResponse
				},
			)
		} catch (error) {
			lastError = error
			const delayMs = Math.min(50, deadlineAt - Date.now())
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
	}
	throw cancellationUnknown(lastError)
}

function parseWorkerEvent(line: string): WorkerEvent {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new WorkerProtocolError(
			`worker emitted malformed NDJSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
		throw new WorkerProtocolError('worker emitted an event without a type')
	}
	const event = parsed as Record<string, unknown>
	if (
		(event.type === 'stdout_delta' || event.type === 'stderr_delta') &&
		typeof event.data === 'string'
	) {
		return event as WorkerEvent
	}
	if (event.type === 'error' && typeof event.error === 'string') return event as WorkerEvent
	if (isTerminalEvent(event)) return event
	throw new WorkerProtocolError(`worker emitted an invalid ${String(event.type)} event`)
}

async function readExecution(
	baseUrl: string,
	executionId: string | undefined,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
	state: OutputState,
	transportSignal?: AbortSignal,
): Promise<SandboxExecResult> {
	let response: Response
	try {
		response = await fetch(`${baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			...(transportSignal ? { signal: transportSignal } : {}),
			body: JSON.stringify({
				...(executionId ? { executionId } : {}),
				command,
				args: argv ?? [],
				cwd: opts?.cwd,
				env: opts?.env,
				timeoutMs: opts?.timeout,
			}),
		})
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined
		const causeMessage =
			cause instanceof Error
				? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
				: cause
					? String(cause)
					: 'unknown'
		throw withHint(
			new Error(
				`namzu-sandbox /execute fetch failed (baseUrl=${baseUrl}): ${error instanceof Error ? error.message : String(error)} — cause: ${causeMessage}`,
				{ cause: error },
			),
			'The worker was reachable when the sandbox started, so it has most likely exited, been killed, or become unreachable since. Check the container logs and runtime exit state.',
		)
	}
	if (!response.ok || !response.body) {
		throw new Error(`execute failed: HTTP ${response.status} ${await response.text()}`)
	}

	const decoder = new TextDecoder()
	const reader = response.body.getReader()
	let buffered = ''
	let terminal: Extract<WorkerEvent, { type: 'result' }> | undefined
	let terminalCount = 0

	const consume = (rawLine: string) => {
		if (!rawLine.trim()) return
		const event = parseWorkerEvent(rawLine)
		if (terminalCount > 0) {
			throw new WorkerProtocolError('worker emitted data after its terminal event')
		}
		if (event.type === 'stdout_delta') {
			state.stdout += event.data
			opts?.onOutput?.({ stream: 'stdout', data: event.data })
			return
		}
		if (event.type === 'stderr_delta') {
			state.stderr += event.data
			opts?.onOutput?.({ stream: 'stderr', data: event.data })
			return
		}
		terminalCount += 1
		if (event.type === 'error') throw new WorkerExecutionError(event.error)
		terminal = event
	}

	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buffered += decoder.decode(value, { stream: true })
		let newline = buffered.indexOf('\n')
		while (newline !== -1) {
			consume(buffered.slice(0, newline))
			buffered = buffered.slice(newline + 1)
			newline = buffered.indexOf('\n')
		}
	}
	buffered += decoder.decode()
	if (buffered.trim()) consume(buffered)
	if (terminalCount !== 1 || !terminal) {
		throw new WorkerProtocolError('worker response ended without exactly one result event')
	}

	return {
		exitCode: terminal.exitCode,
		stdout: state.stdout,
		stderr: state.stderr,
		...(terminal.signal ? { signal: terminal.signal } : {}),
		timedOut: terminal.timedOut,
		durationMs: terminal.durationMs,
		...(terminal.stdoutTruncated !== undefined
			? { stdoutTruncated: terminal.stdoutTruncated }
			: {}),
		...(terminal.stderrTruncated !== undefined
			? { stderrTruncated: terminal.stderrTruncated }
			: {}),
	}
}

async function drainConfirmedExecution(
	pending: Promise<SandboxExecResult>,
	cancelled: CancelResponse,
	state: OutputState,
): Promise<SandboxExecResult> {
	if (!cancelled.started) {
		const result = cancelled.result
		return result
			? { ...result, stdout: state.stdout, stderr: state.stderr }
			: cancelledBeforeStart(Date.now())
	}
	try {
		return await bounded('sandbox terminal-result drain', RESULT_DRAIN_TIMEOUT_MS, async () => {
			return await pending
		})
	} catch (error) {
		if (error instanceof WorkerExecutionError && cancelled.state === 'failed') throw error
		throw resultIncomplete(error, cancelled)
	}
}

/**
 * Execute over the shared HTTP worker used by the local-container and standby
 * backends. A signal opts into protocol v2's reserve/cancel ownership. Calls
 * without one retain the legacy single-request wire for rolling worker-image
 * compatibility.
 */
export async function execViaHttpWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
	const startedAt = Date.now()
	const state: OutputState = { stdout: '', stderr: '' }
	if (!opts?.signal) return await readExecution(baseUrl, undefined, command, argv, opts, state)
	if (opts.signal.aborted) return cancelledBeforeStart(startedAt)

	let executionId: string
	try {
		executionId = await reserveExecution(baseUrl, opts.signal)
	} catch (error) {
		if (opts.signal.aborted) return cancelledBeforeStart(startedAt)
		throw error
	}

	if (opts.signal.aborted) {
		return await drainConfirmedExecution(
			new Promise<SandboxExecResult>(() => undefined),
			await requestCancellation(baseUrl, executionId),
			state,
		)
	}

	type CancellationReason = 'caller' | 'observation-timeout' | 'reconcile'
	let cancellationReason: CancellationReason | undefined
	let startCancellation: ((reason: CancellationReason) => void) | undefined
	const cancellation = new Promise<CancelResponse>((resolve, reject) => {
		let started = false
		startCancellation = (reason) => {
			if (started) return
			started = true
			cancellationReason = reason
			void requestCancellation(baseUrl, executionId).then(resolve, reject)
		}
	})
	const onAbort = () => startCancellation?.('caller')
	opts.signal.addEventListener('abort', onAbort, { once: true })
	if (opts.signal.aborted) onAbort()
	const observationTimer = setTimeout(
		() => startCancellation?.('observation-timeout'),
		observationDeadlineMs(opts.timeout),
	)
	observationTimer.unref?.()

	const executionTransport = new AbortController()
	const execution = readExecution(
		baseUrl,
		executionId,
		command,
		argv,
		opts,
		state,
		executionTransport.signal,
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
			const result = await drainConfirmedExecution(execution, first.result, state)
			return cancellationReason === 'observation-timeout' ? { ...result, timedOut: true } : result
		}

		// Every failure after a reservation may have happened while the command
		// was still live. Reconcile through the same idempotent cancellation path
		// before surfacing the original error.
		startCancellation?.('reconcile')
		let confirmed: CancelResponse
		try {
			confirmed = await cancellation
		} catch (cancelError) {
			throw cancellationUnknown(cancelError)
		}
		if (first.error instanceof WorkerExecutionError && confirmed.state === 'failed') {
			throw first.error
		}
		if (opts.signal.aborted && confirmed.state === 'cancelled' && !confirmed.started) {
			return await drainConfirmedExecution(execution, confirmed, state)
		}
		if (!confirmed.started) throw first.error
		throw resultIncomplete(first.error, confirmed)
	} finally {
		clearTimeout(observationTimer)
		opts.signal.removeEventListener('abort', onAbort)
		// This is a private transport signal, never the caller's cancellation
		// signal. It is fired only after a normal terminal result or after the
		// cancel/unknown-outcome path has classified the remote operation, so an
		// abandoned HTTP body cannot retain a socket or reader indefinitely.
		executionTransport.abort(new Error('sandbox execution observation finished'))
	}
}
