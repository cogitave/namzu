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
// Credential — the one optional field every request envelope may carry
// ---------------------------------------------------------------------------

/**
 * The per-instance credential a framed request may present, mixed into
 * the request envelope alongside its `op`.
 *
 * Absent on the vsock and unix transports: that control channel is
 * host↔guest only and never traverses guest egress, so the guest agent
 * authenticates nothing there and this field is simply never written.
 * A guest reached over a ROUTED network has no such boundary, so it is
 * started with a per-instance token (`NAMZU_AGENT_BIND_TOKEN`, fed the
 * pod's own identity by its orchestrator) and refuses every op but
 * `healthz` that does not present exactly that value — from the first
 * frame, since the agent dispatches a connection on its first frame and
 * there is no handshake to defer the check to.
 *
 * The field is OPTIONAL and additive, so a host that never sets it
 * speaks the same wire it always did and
 * `FIRECRACKER_AGENT_PROTOCOL_VERSION` is deliberately unchanged: this
 * needs no coupled golden-image and host rollout.
 */
export interface AgentRequestCredential {
	readonly token?: string
}

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
	/**
	 * Ask the guest to keep this command's output in its retained log, so a
	 * host that loses the data connection can reattach by execution id and
	 * read on from the offset it reached.
	 *
	 * Requires `executionId` — a log nobody can name is a log nobody can
	 * attach to — and requires the guest to advertise `execution-attach` in
	 * its `healthz` features. Omitted on every ordinary exec, which is why
	 * the default wire request is byte-for-byte what it has always been.
	 */
	readonly retainOutput?: boolean
}

/**
 * One NDJSON event the agent emits while streaming an `/execute`. The
 * exact union the HTTP worker writes via `writeEvent`:
 *   { type: 'stdout_delta', data }
 *   { type: 'stderr_delta', data }
 *
 * A delta of an execution the guest was asked to RETAIN also carries
 * `offset` and `nextOffset`: the bytes the chunk occupies in that
 * execution's retained log. They are additive, ignored by every consumer
 * that does not reattach, and they are the only correct source for a
 * reattach cursor — see {@link parseExecEvent}.
 *   { type: 'result', exitCode, timedOut, durationMs, stdoutTruncated?, stderrTruncated? }
 *   { type: 'error', error }
 */
export type ExecEvent =
	| {
			readonly type: 'stdout_delta'
			readonly data: string
			readonly offset?: number
			readonly nextOffset?: number
	  }
	| {
			readonly type: 'stderr_delta'
			readonly data: string
			readonly offset?: number
			readonly nextOffset?: number
	  }
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

/**
 * One slice of a `write-file` body, for a body too large to cross the wire
 * in a single frame.
 *
 * ADDITIVE, and deliberately so: the guest protocol version is unchanged,
 * an agent that predates this field ignores it, and a host only ever sends
 * it to an agent that advertised {@link WRITE_FILE_PARTS_FEATURE} in its
 * `healthz` reply. The sequence writes a temporary sibling of the target
 * (`WriteFileRequest.path` names the TEMP file while `part` is present, so
 * an agent that dropped the field would overwrite the temp file rather
 * than the target) and finishes with an atomic rename onto `renameTo`.
 */
export interface WriteFilePart {
	/**
	 * Byte offset in the temp file this slice starts at. `0` creates or
	 * truncates it; any other value must equal the temp file's CURRENT
	 * size, so a lost, duplicated or reordered part is refused rather
	 * than silently producing a corrupt file.
	 */
	readonly offset?: number
	/** Last slice: rename the temp file onto {@link renameTo} once written. */
	readonly final?: boolean
	/** The real target, required when {@link final} is true. */
	readonly renameTo?: string
	/**
	 * Remove the temp file named by `path` and write nothing — the
	 * best-effort cleanup a host runs when a part sequence is abandoned.
	 * `content` is ignored.
	 */
	readonly discard?: boolean
}

/** `/write-file` request body. `content` is base64. */
export interface WriteFileRequest {
	readonly path: string
	readonly content: string
	readonly encoding: 'base64'
	/** Present only for a chunked write; see {@link WriteFilePart}. */
	readonly part?: WriteFilePart
}

/** `/write-file` success response. */
export interface WriteFileResponse {
	readonly ok: boolean
	readonly bytesWritten?: number
	/** Total size of the temp file after this part, for a chunked write. */
	readonly sizeBytes?: number
	readonly error?: string
}

/**
 * The `healthz` feature string an agent advertises when it implements
 * {@link WriteFilePart}. A host that does not see it in `features` keeps
 * to the single-frame write and its named too-large error.
 */
export const WRITE_FILE_PARTS_FEATURE = 'write-file-parts'

/**
 * The `healthz` feature string an agent advertises when it accepts a
 * caller-chosen `executionId`, an `execute` carrying `retainOutput`, and
 * the `attach-execution` op that replays a retained execution's output by
 * byte offset.
 *
 * A host asking for a detachable command against a guest that does not
 * advertise it is refused BEFORE the command is admitted, rather than
 * starting one whose output nothing keeps.
 */
export const EXECUTION_ATTACH_FEATURE = 'execution-attach'

/**
 * `/read-file` request body.
 *
 * `offset`/`length` are ADDITIVE and gated exactly as {@link WriteFilePart}
 * is: a host sends them only to an agent that advertised
 * {@link READ_FILE_STREAM_FEATURE} in its `healthz` reply, because an agent
 * that predates them ignores both and answers with the WHOLE file — which
 * the caller would read as its slice. Omitting both is the whole-file read
 * this op has always served, byte for byte.
 */
export interface ReadFileRequest {
	readonly path: string
	readonly encoding: 'base64'
	/** First byte of the slice. Defaults to 0 when only `length` is given. */
	readonly offset?: number
	/**
	 * How many bytes to answer with. Defaults to the rest of the file, and
	 * is REFUSED rather than shortened above the guest's per-frame range
	 * ceiling (`NAMZU_AGENT_READ_FILE_RANGE_BYTES`, 1 MiB by default) — a
	 * whole file goes through {@link ReadFileStreamRequest} instead.
	 */
	readonly length?: number
}

/**
 * `read-file-stream` request body — one file as an ordered sequence of
 * frames rather than one reply.
 *
 * `offset`/`length` are accepted and deliberately NOT capped: this op is
 * where {@link ReadFileRequest}'s range ceiling sends a caller who wants
 * more than one frame's worth.
 */
export interface ReadFileStreamRequest {
	readonly path: string
	readonly offset?: number
	readonly length?: number
}

/**
 * Guest → host frames for one `read-file-stream`, in order: exactly one
 * `meta`, zero or more `data`, then one `end` — or a single `error`
 * instead of any of them — followed by the zero-length terminator.
 *
 * `data` is base64 for the same reason every other payload on this wire
 * is: the frame body is UTF-8 JSON, which cannot carry arbitrary bytes.
 */
export type ReadFileStreamEvent =
	| {
			readonly type: 'meta'
			/** The WHOLE file's size, never the slice's — how a caller knows where it ends. */
			readonly sizeBytes: number
			readonly offset: number
			/** What this stream intends to send, after clamping to EOF. */
			readonly length: number
	  }
	| { readonly type: 'data'; readonly data: string }
	| { readonly type: 'end'; readonly bytesSent: number }
	| { readonly type: 'error'; readonly error: string }

/**
 * The `healthz` feature string an agent advertises when `read-file`
 * honours {@link ReadFileRequest.offset}/`length` AND the
 * `read-file-stream` op exists. ONE string for both halves because they
 * ship together in `agent/agent.cjs` and no guest can have one without the
 * other; a host that does not see it sends neither shape and keeps to the
 * single whole-file reply.
 */
export const READ_FILE_STREAM_FEATURE = 'read-file-stream'

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
	/** See {@link StreamHeartbeat}. Absent → no heartbeat on this stream. */
	readonly heartbeatMs?: number
	/**
	 * Name this terminal so it can be found again. Both fields are ADDITIVE
	 * and both are required together: a guest that predates them ignores
	 * them and serves the connection-bound terminal it always served, which
	 * is why a host only ever sends them to one advertising
	 * {@link SESSIONS_FEATURE}.
	 *
	 * With them, the PTY belongs to the guest's session registry rather than
	 * to this connection: output is read into a retained log whether or not
	 * anybody is attached, and closing the connection detaches instead of
	 * killing.
	 */
	readonly sessionId?: string
	readonly persistent?: boolean
}

/** Host → guest messages after the terminal stream reports ready. */
export type TerminalInputEvent =
	| { readonly type: 'input'; readonly data: string }
	| { readonly type: 'resize'; readonly cols: number; readonly rows: number }
	| { readonly type: 'kill'; readonly signal?: string }
	| StreamHeartbeat

/** Guest → host events carried for the lifetime of the terminal stream. */
export type TerminalOutputEvent =
	| TerminalReadyEvent
	| {
			readonly type: 'data'
			readonly data: string
			/** Only on a session stream: where this chunk sits in the retained log. */
			readonly stream?: SessionStreamName
			readonly offset?: number
			readonly nextOffset?: number
	  }
	| {
			readonly type: 'exit'
			readonly exitCode: number
			readonly signal?: number
			readonly nextOffset?: number
	  }
	| SessionDetachedEvent
	| { readonly type: 'error'; readonly error: string }
	| StreamHeartbeat

/**
 * The opening frame of a terminal stream, and the one place the session ops
 * add to it.
 *
 * Every session field is optional because a connection-bound terminal sends
 * none of them, and a guest that predates the registry sends none either.
 */
export interface TerminalReadyEvent {
	readonly type: 'ready'
	readonly heartbeatMs?: number
	readonly sessionId?: string
	readonly kind?: SessionKind
	readonly state?: SessionState
	/** Where the replay this stream is about to send begins. */
	readonly fromOffset?: number
	/** Bytes evicted between what the reader asked for and what survived. */
	readonly droppedBytes?: number
	/** One past the newest byte the guest had when the stream opened. */
	readonly nextOffset?: number
	readonly exitCode?: number
	readonly signal?: number
}

// ---------------------------------------------------------------------------
// Sessions — a program that outlives the connection that started it
// ---------------------------------------------------------------------------

/**
 * The `healthz` feature string an agent advertises when it keeps a session
 * registry: `terminal` with `{ sessionId, persistent: true }`, plus the
 * `attach-session`, `start-detached`, `list-sessions` and `kill-session`
 * ops.
 *
 * A host asking for any of them against a guest that does not advertise it
 * is refused by name and never falls back to a connection-bound terminal: a
 * caller that asked for a session is about to rely on coming back to it, and
 * handing it one that dies with the socket would keep nothing and tell
 * nobody.
 */
export const SESSIONS_FEATURE = 'sessions'

/** A PTY, or a program started with no terminal at all. */
export type SessionKind = 'terminal' | 'detached'

export type SessionState = 'running' | 'exited'

/** Which of the two streams a retained chunk came from. */
export type SessionStreamName = 'stdout' | 'stderr'

/** Why an attachment ended without the program exiting. */
export type SessionDetachReason = 'superseded' | 'slow_reader'

/**
 * Sent to the attachment a session is taking away from it. It is never an
 * exit: the program is still running, and the reason says who took it.
 */
export interface SessionDetachedEvent {
	readonly type: 'detached'
	readonly reason: SessionDetachReason
}

/** Read one session's retained output, and optionally follow it live. */
export interface AttachSessionRequest {
	readonly sessionId: string
	/** Byte offset to resume from. Default 0 — the whole retained log. */
	readonly fromOffset?: number
	/**
	 * `false` replays what is retained and ends. Default `true`: stay
	 * attached, and — for a terminal session — accept input and resize.
	 */
	readonly follow?: boolean
	/** Resize the PTY on attach, for a terminal whose new reader has its own window. */
	readonly cols?: number
	readonly rows?: number
	/** See {@link StreamHeartbeat}. Absent → no heartbeat on this stream. */
	readonly heartbeatMs?: number
}

/** Start a program with no terminal, which nothing but a kill ends. */
export interface StartDetachedRequest {
	readonly sessionId: string
	readonly command: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Record<string, string>
}

/** End one session and everything still in it. */
export interface KillSessionRequest {
	readonly sessionId: string
	/** `SIGTERM`, `SIGKILL`, `SIGINT` or `SIGHUP`. Default `SIGKILL`. */
	readonly signal?: string
}

// ---------------------------------------------------------------------------
// Loopback TCP — publish a service without moving it out of the sandbox
// ---------------------------------------------------------------------------

export interface TcpConnectRequest {
	readonly host: '127.0.0.1' | '::1'
	readonly port: number
	/** See {@link StreamHeartbeat}. Absent → no heartbeat on this stream. */
	readonly heartbeatMs?: number
}

export type TcpInputEvent =
	| { readonly type: 'data'; readonly data: string }
	| { readonly type: 'end' }
	| { readonly type: 'destroy' }
	| StreamHeartbeat

export type TcpOutputEvent =
	| { readonly type: 'ready'; readonly heartbeatMs?: number }
	| { readonly type: 'data'; readonly data: string }
	| { readonly type: 'end' }
	| { readonly type: 'error'; readonly error: string }
	| StreamHeartbeat

// ---------------------------------------------------------------------------
// Stream liveness — telling a quiet peer from a dead one
// ---------------------------------------------------------------------------

/**
 * The one frame either side of an open `terminal` or `tcp-connect` stream
 * may send to say it is still there.
 *
 * Once a stream reports `ready` the transport clears its read-idle timer,
 * correctly: an interactive shell may sit silent for hours and a timer would
 * kill a healthy one. So nothing was left that could tell that shell from a
 * host that vanished without a FIN or an RST — a lost node, a partition, a
 * middlebox that drops idle state. TCP keepalive proves only that the peer's
 * KERNEL answers, and a `healthz` proves only that a FRESH connection is
 * served; neither says anything about the stream in hand.
 *
 * **Negotiated per stream, in both directions.** The open request carries
 * {@link TerminalOpenRequest.heartbeatMs} / {@link TcpConnectRequest.heartbeatMs};
 * a guest that implements this echoes the interval it will use back in its
 * `ready` event and only then starts sending, and the host only starts once
 * that echo arrived. An agent that predates the field ignores it and echoes
 * nothing, so the host behaves exactly as it did; an older HOST — which ends
 * a stream with an error on any frame type it does not know — is never sent
 * one, because it never asked.
 *
 * Anything arriving from the other side counts as proof of life, not just
 * this frame and not even a whole frame: both sides count BYTES, so a single
 * large frame that takes longer than the window to arrive cannot be read as
 * the peer having gone away. {@link STREAM_HEARTBEAT_MISS_LIMIT} consecutive
 * intervals with nothing at all end the stream: the host resolves `exited`
 * with `exitCode: -1` (what a closed socket already produces) or resolves
 * `closed`, and the guest runs the same close cleanup it runs for a socket
 * that went away. Detection lands within those intervals plus at most one
 * watchdog tick, since each side polls at a quarter of the interval rather
 * than at it. Silence while a side has paused reading for backpressure is
 * not silence — that side chose it, and the bytes are waiting in the kernel.
 */
export type StreamHeartbeat = { readonly type: 'heartbeat' }

/** Missed intervals that end a stream. Three, so one lost frame is not fatal. */
export const STREAM_HEARTBEAT_MISS_LIMIT = 3

/**
 * The shortest interval either side will run a heartbeat at.
 *
 * The interval arrives from the host, so the guest clamps it to this before
 * using it and echoes the CLAMPED value — otherwise an authenticated host
 * could ask for a fraction of a millisecond and leave the agent doing
 * nothing but writing heartbeats.
 */
export const MIN_STREAM_HEARTBEAT_MS = 100

/**
 * How far above what it asked for a host will honour the guest's echo.
 *
 * The echo is a number from the pod, and the host does its own watchdog
 * arithmetic with it: unclamped, a guest echoing a fraction of a millisecond
 * makes the host tear the stream down on its first tick, and one echoing a
 * day disables the host's detection entirely. A guest that clamps the way
 * this one does always echoes a value inside the band, so the honest case is
 * never altered.
 */
export const STREAM_HEARTBEAT_MAX_ECHO_FACTOR = 4

/**
 * The `healthz` feature string an agent advertises when it understands
 * {@link StreamHeartbeat}. Informational for the host — the per-stream
 * `ready` echo is what actually arms anything — and the honest answer for an
 * operator reading a `healthz` reply to find out what an image can do.
 */
export const STREAM_HEARTBEAT_FEATURE = 'stream-heartbeat'

/** `/read-file` response. `content` is base64 on success. */
export interface ReadFileResponse {
	readonly ok: boolean
	readonly content?: string
	/** The WHOLE file's size, in both the whole-file and the ranged shape. */
	readonly sizeBytes?: number
	readonly encoding?: string
	readonly error?: string
	/** Present only on a ranged reply: the first byte `content` starts at. */
	readonly offset?: number
	/**
	 * Present only on a ranged reply: how many bytes `content` decodes to.
	 * Below the requested `length` when the range ran past EOF, which is an
	 * answer rather than an error.
	 */
	readonly bytesRead?: number
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
	return parseExecEvent(parsed)
}

/**
 * The same structural validation over an event that has ALREADY been
 * parsed out of its frame.
 *
 * Split out of {@link parseExecLine} for the caller that reads the exec
 * stream frame by frame rather than as NDJSON text — the Kubernetes
 * detached execution, which needs the raw object to read the retained-log
 * offsets off it. One validation, two entry points: an ordinary exec and a
 * detached one must never disagree about what a valid frame is.
 */
export function parseExecEvent(parsed: unknown): ExecEvent {
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
