/**
 * The ONE wire contract, shared across both transports.
 *
 * The docker (`backends/docker/`) and ACI (`backends/aci-standby-pool/`)
 * backends speak this contract over **HTTP**: a streaming NDJSON
 * `/execute` response and base64-bodied `/read-file` / `/write-file`
 * JSON requests, served by `worker/server.js`. The Firecracker
 * backend speaks the **same NDJSON shapes and the same base64 file-IO
 * shapes** — only the transport changes from HTTP-over-TCP to
 * framed-over-vsock (see `transport.ts`).
 *
 * This module is the single source of truth for the message shapes
 * and the streaming exec-line parser, so the two transports cannot
 * drift. It deliberately carries NO transport concern (no `fetch`, no
 * socket) — it is pure codec. The HTTP backends keep their own inline
 * copies (they predate this module and stay UNTOUCHED per the P0
 * scope); this module mirrors those shapes verbatim and is the
 * canonical definition the vsock path consumes.
 *
 * Why mirror rather than refactor docker/aci onto it: the P0 scope is
 * "do NOT touch docker or aci". Centralising the shapes here, with the
 * inline docker copy pinned by `backends/docker/__tests__` and this
 * module pinned by `backends/firecracker/__tests__`, keeps both honest
 * without editing the frozen HTTP path. A later cleanup pass can fold
 * docker/aci onto this module once it is no longer release-frozen.
 */

import type { SandboxExecResult } from '@namzu/sdk'

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
			readonly durationMs?: number
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
 * transport owns newline-framing → JSON.parse → here). Malformed lines
 * are dropped by the transport's `JSON.parse` guard before they reach
 * this accumulator, matching the docker loop's `SyntaxError` swallow.
 */
export class ExecResultAccumulator {
	private stdout = ''
	private stderr = ''
	private exitCode = -1
	private timedOut = false
	private signal: string | undefined
	private settled = false
	private readonly start: number

	constructor(start: number = Date.now()) {
		this.start = start
	}

	/**
	 * Apply one event. Returns `true` once a terminal `result` has been
	 * seen (so the transport can stop reading early if it wants).
	 * Throws if the event is an `error` — the same control flow the
	 * docker loop uses (`throw new Error(event.error)`).
	 */
	push(event: ExecEvent): boolean {
		if (event.type === 'stdout_delta') {
			this.stdout += event.data
			return false
		}
		if (event.type === 'stderr_delta') {
			this.stderr += event.data
			return false
		}
		if (event.type === 'result') {
			this.exitCode = event.exitCode
			this.timedOut = event.timedOut
			this.settled = true
			return true
		}
		// event.type === 'error'
		throw new Error(event.error)
	}

	get done(): boolean {
		return this.settled
	}

	/** Build the SDK-shaped result. `durationMs` measured host-side. */
	finish(): SandboxExecResult {
		return {
			exitCode: this.exitCode,
			stdout: this.stdout,
			stderr: this.stderr,
			...(this.signal ? { signal: this.signal } : {}),
			timedOut: this.timedOut,
			durationMs: Date.now() - this.start,
		}
	}
}

/**
 * Parse a single NDJSON line into an {@link ExecEvent}, or `undefined`
 * if the line is blank or not valid JSON (the docker loop's
 * `SyntaxError` swallow). Non-`SyntaxError` problems are impossible
 * here because we only `JSON.parse`; structural validation is by the
 * `type` discriminator at the call site.
 */
export function parseExecLine(line: string): ExecEvent | undefined {
	const trimmed = line.trim()
	if (!trimmed) return undefined
	try {
		return JSON.parse(trimmed) as ExecEvent
	} catch (err) {
		if (err instanceof SyntaxError) return undefined
		throw err
	}
}
