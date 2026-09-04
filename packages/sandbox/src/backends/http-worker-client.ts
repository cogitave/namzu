import { type SandboxExecOptions, type SandboxExecResult, withHint } from '@namzu/sdk'

import {
	RemoteCommandError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
	RemoteProtocolError,
} from './remote-execution-controller.js'

type WorkerEvent =
	| { readonly type: 'stdout_delta'; readonly data: string }
	| { readonly type: 'stderr_delta'; readonly data: string }
	| {
			readonly type: 'result'
			readonly exitCode: number
			readonly timedOut: boolean
			readonly durationMs: number
			readonly signal?: string
			readonly stdoutTruncated?: boolean
			readonly stderrTruncated?: boolean
	  }
	| { readonly type: 'error'; readonly error: string }

function parseWorkerEvent(line: string): WorkerEvent {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new RemoteProtocolError(
			`worker emitted malformed NDJSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new RemoteProtocolError('worker emitted an event without an object body')
	}
	const event = parsed as Record<string, unknown>
	if (
		(event.type === 'stdout_delta' || event.type === 'stderr_delta') &&
		typeof event.data === 'string'
	) {
		return event as WorkerEvent
	}
	if (event.type === 'error' && typeof event.error === 'string') return event as WorkerEvent
	if (
		event.type === 'result' &&
		Number.isFinite(event.exitCode) &&
		typeof event.timedOut === 'boolean' &&
		Number.isFinite(event.durationMs) &&
		(event.signal === undefined || typeof event.signal === 'string') &&
		(event.stdoutTruncated === undefined || typeof event.stdoutTruncated === 'boolean') &&
		(event.stderrTruncated === undefined || typeof event.stderrTruncated === 'boolean')
	) {
		return event as WorkerEvent
	}
	throw new RemoteProtocolError(`worker emitted an invalid ${String(event.type)} event`)
}

async function readExecution(
	baseUrl: string,
	executionId: string | undefined,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
	transportSignal: AbortSignal,
): Promise<SandboxExecResult> {
	let response: Response
	try {
		response = await fetch(`${baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: transportSignal,
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
	let stdout = ''
	let stderr = ''
	let terminal: Extract<WorkerEvent, { type: 'result' }> | undefined
	let terminalCount = 0

	const consume = (rawLine: string): void => {
		if (!rawLine.trim()) return
		const event = parseWorkerEvent(rawLine)
		if (terminalCount > 0) {
			throw new RemoteProtocolError('worker emitted data after its terminal event')
		}
		if (event.type === 'stdout_delta') {
			stdout += event.data
			opts?.onOutput?.({ stream: 'stdout', data: event.data })
			return
		}
		if (event.type === 'stderr_delta') {
			stderr += event.data
			opts?.onOutput?.({ stream: 'stderr', data: event.data })
			return
		}
		terminalCount += 1
		if (event.type === 'error') throw new RemoteCommandError(event.error)
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
		throw new RemoteProtocolError('worker response ended without exactly one result event')
	}

	return {
		exitCode: terminal.exitCode,
		stdout,
		stderr,
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

/**
 * A per-sandbox HTTP worker client. Every command must reserve an identity
 * through the exact worker protocol before it can be admitted.
 */
export class HttpWorkerClient {
	private readonly controller: RemoteExecutionController

	constructor(baseUrl: string) {
		const adapter: RemoteExecutionAdapter = {
			label: 'HTTP worker',
			reserve: async (signal) => {
				const response = await fetch(`${baseUrl}/executions/reserve`, {
					method: 'POST',
					signal,
				})
				if (response.status === 404) {
					throw new RemoteProtocolError(
						'The sandbox worker does not implement the required execution protocol. Rebuild the worker image or standby-pool profile from the same Namzu release before admitting commands.',
					)
				}
				if (!response.ok) {
					throw new Error(
						`execution reservation failed: HTTP ${response.status} ${await response.text()}`,
					)
				}
				return await response.json()
			},
			cancel: async (executionId, signal) => {
				const response = await fetch(`${baseUrl}/cancel`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ executionId }),
					signal,
				})
				if (!response.ok) {
					throw new Error(`cancel failed: HTTP ${response.status} ${await response.text()}`)
				}
				return await response.json()
			},
			execute: async (executionId, command, argv, opts, signal) =>
				await readExecution(baseUrl, executionId, command, argv, opts, signal),
		}
		this.controller = new RemoteExecutionController(adapter)
	}

	async exec(
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
	): Promise<SandboxExecResult> {
		return await this.controller.exec(command, argv, opts)
	}
}

/** Convenience entry point for focused consumers. */
export async function execViaHttpWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
	return await new HttpWorkerClient(baseUrl).exec(command, argv, opts)
}
