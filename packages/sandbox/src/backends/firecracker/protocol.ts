/**
 * The execution-data codec shared by both transports.
 *
 * The docker (`backends/docker/`) and ACI (`backends/aci-standby-pool/`)
 * backends speak this contract over **HTTP**: a streaming NDJSON
 * `/execute` response and base64-bodied `/read-file` / `/write-file`
 * JSON requests, served by `worker/server.js`. The Firecracker
 * backend speaks the **same NDJSON shapes and the same base64 file-IO
 * shapes** — only the transport changes from HTTP-over-TCP to
 * framed-over-vsock (see `transport.ts`).
 *
 * This module remains the pure codec consumed by the framed guest transport.
 * The two HTTP backends share one strict HTTP client, and both transports put
 * the same reserve-before-admission + idempotent-cancel state machine around
 * these data events. HTTP uses endpoints; the framed guest uses dedicated ops.
 */

import type { SandboxExecOptions, SandboxExecResult } from '@namzu/sdk'

import { RemoteCommandError, RemoteProtocolError } from '../remote-execution-controller.js'

// ---------------------------------------------------------------------------
// Exec — request + the NDJSON event shapes (verbatim from worker/server.js)
// ---------------------------------------------------------------------------

/**
 * `/execute` request body. Identical field set to the HTTP worker's
 * `handleExecute` body (`command`, `args`, `cwd`, `env`, `stdin`,
 * `timeoutMs`, `maxOutputBytes`). `timeoutMs` maps from the SDK's
 * `SandboxExecOptions.timeout`.
 */
export interface ExecRequest {
	readonly executionId?: string
	readonly command: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Record<string, string>
	readonly stdin?: string
	readonly timeoutMs?: number
	readonly maxOutputBytes?: number
}

/**
 * One NDJSON event the agent emits while streaming an `/execute`. The
 * exact union the HTTP worker writes via `writeEvent`:
 *   { type: 'stdout_delta', data }
 *   { type: 'stderr_delta', data }
 *   { type: 'result', exitCode, timedOut, durationMs, stdoutTruncated?, stderrTruncated? }
 *   { type: 'error', error }
 */
export type ExecEvent =
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

// ---------------------------------------------------------------------------
// File-IO — base64 request + response shapes (verbatim from server.js)
// ---------------------------------------------------------------------------

/** `/write-file` request body. `content` is base64. */
export interface WriteFileRequest {
	readonly path: string
	readonly content: string
	readonly encoding: 'base64'
}

/** `/write-file` success response. */
export interface WriteFileResponse {
	readonly ok: boolean
	readonly bytesWritten?: number
	readonly error?: string
}

/** `/read-file` request body. */
export interface ReadFileRequest {
	readonly path: string
	readonly encoding: 'base64'
}

// ---------------------------------------------------------------------------
// Terminal — a real guest-owned PTY over the same framed stream
// ---------------------------------------------------------------------------

/** Initial request for one interactive terminal process in the guest. */
export interface TerminalOpenRequest {
	readonly command?: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Record<string, string>
	readonly cols: number
	readonly rows: number
}

/** Host → guest messages after the terminal stream reports ready. */
export type TerminalInputEvent =
	| { readonly type: 'input'; readonly data: string }
	| { readonly type: 'resize'; readonly cols: number; readonly rows: number }
	| { readonly type: 'kill'; readonly signal?: string }

/** Guest → host events carried for the lifetime of the terminal stream. */
export type TerminalOutputEvent =
	| { readonly type: 'ready' }
	| { readonly type: 'data'; readonly data: string }
	| {
			readonly type: 'exit'
			readonly exitCode: number
			readonly signal?: number
	  }
	| { readonly type: 'error'; readonly error: string }

// ---------------------------------------------------------------------------
// Loopback TCP — publish a service without moving it out of the sandbox
// ---------------------------------------------------------------------------

export interface TcpConnectRequest {
	readonly host: '127.0.0.1' | '::1'
	readonly port: number
}

export type TcpInputEvent =
	| { readonly type: 'data'; readonly data: string }
	| { readonly type: 'end' }
	| { readonly type: 'destroy' }

export type TcpOutputEvent =
	| { readonly type: 'ready' }
	| { readonly type: 'data'; readonly data: string }
	| { readonly type: 'end' }
	| { readonly type: 'error'; readonly error: string }

/** `/read-file` response. `content` is base64 on success. */
export interface ReadFileResponse {
	readonly ok: boolean
	readonly content?: string
	readonly sizeBytes?: number
	readonly encoding?: string
	readonly error?: string
}

// ---------------------------------------------------------------------------
// Streaming exec-line accumulator — the parser docker/aci inline today,
// lifted out so the vsock transport reuses it byte-for-byte.
// ---------------------------------------------------------------------------

/**
 * Accumulates the streamed `/execute` NDJSON into a single
 * {@link SandboxExecResult}, exactly as the docker/aci `execViaWorker`
 * loops do: concatenate `stdout_delta` / `stderr_delta`, capture the
 * terminal `result`, and **throw** on an `error` event.
 *
 * Transport-agnostic: feed it whole parsed {@link ExecEvent}s (the
 * transport owns framing → strict JSON validation → here). Malformed or
 * trailing events are protocol failures rather than silently discarded data.
 */
export class ExecResultAccumulator {
	private stdout = ''
	private stderr = ''
	private exitCode = -1
	private timedOut = false
	private signal: string | undefined
	private durationMs: number | undefined
	private stdoutTruncated: boolean | undefined
	private stderrTruncated: boolean | undefined
	private settled = false
	private readonly start: number
	private readonly onOutput: SandboxExecOptions['onOutput']

	constructor(start: number = Date.now(), onOutput?: SandboxExecOptions['onOutput']) {
		this.start = start
		this.onOutput = onOutput
	}

	/**
	 * Apply one event. Returns `true` once a terminal `result` has been
	 * seen (so the transport can stop reading early if it wants).
	 * Throws if the event is an `error` — the same control flow the
	 * docker loop uses (`throw new Error(event.error)`).
	 */
	push(event: ExecEvent): boolean {
		if (this.settled) {
			throw new RemoteProtocolError('exec stream emitted data after its terminal event')
		}
		if (event.type === 'stdout_delta') {
			this.stdout += event.data
			this.onOutput?.({ stream: 'stdout', data: event.data })
			return false
		}
		if (event.type === 'stderr_delta') {
			this.stderr += event.data
			this.onOutput?.({ stream: 'stderr', data: event.data })
			return false
		}
		if (event.type === 'result') {
			this.exitCode = event.exitCode
			this.timedOut = event.timedOut
			this.durationMs = event.durationMs
			this.signal = event.signal
			this.stdoutTruncated = event.stdoutTruncated
			this.stderrTruncated = event.stderrTruncated
			this.settled = true
			return true
		}
		// event.type === 'error'
		throw new RemoteCommandError(event.error)
	}

	get done(): boolean {
		return this.settled
	}

	/** Build the SDK-shaped result from the guest's terminal metadata. */
	finish(): SandboxExecResult {
		if (!this.settled || this.durationMs === undefined) {
			throw new RemoteProtocolError('exec stream ended without exactly one result event')
		}
		return {
			exitCode: this.exitCode,
			stdout: this.stdout,
			stderr: this.stderr,
			...(this.signal ? { signal: this.signal } : {}),
			timedOut: this.timedOut,
			durationMs: this.durationMs ?? Date.now() - this.start,
			...(this.stdoutTruncated !== undefined ? { stdoutTruncated: this.stdoutTruncated } : {}),
			...(this.stderrTruncated !== undefined ? { stderrTruncated: this.stderrTruncated } : {}),
		}
	}
}

/**
 * Parse and structurally validate a single NDJSON event. Blank padding is
 * ignored; malformed JSON and unknown/partial event shapes are refused.
 */
export function parseExecLine(line: string): ExecEvent | undefined {
	const trimmed = line.trim()
	if (!trimmed) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch (error) {
		throw new RemoteProtocolError(
			`agent emitted malformed NDJSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new RemoteProtocolError('agent emitted an event without an object body')
	}
	const event = parsed as Record<string, unknown>
	if (
		(event.type === 'stdout_delta' || event.type === 'stderr_delta') &&
		typeof event.data === 'string'
	) {
		return event as ExecEvent
	}
	if (event.type === 'error' && typeof event.error === 'string') return event as ExecEvent
	if (
		event.type === 'result' &&
		Number.isFinite(event.exitCode) &&
		typeof event.timedOut === 'boolean' &&
		Number.isFinite(event.durationMs) &&
		(event.signal === undefined || typeof event.signal === 'string') &&
		(event.stdoutTruncated === undefined || typeof event.stdoutTruncated === 'boolean') &&
		(event.stderrTruncated === undefined || typeof event.stderrTruncated === 'boolean')
	) {
		return event as ExecEvent
	}
	throw new RemoteProtocolError(`agent emitted an invalid ${String(event.type)} event`)
}
