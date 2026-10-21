import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { NativeAnalysisError } from './errors.js'
import { type ResolvedSidecar, resolveSidecar } from './resolve.js'
import type {
	BinaryInfo,
	ExportsResult,
	ExtractParams,
	ExtractedEmbedded,
	Hello,
	ImportsParams,
	ImportsResult,
	NativeOp,
	StringsParams,
	StringsResult,
	SymbolsParams,
	SymbolsResult,
	TargetParams,
} from './types.js'

export interface NativeAnalysisOptions {
	/** Explicit sidecar path. Otherwise see `resolveSidecar`. */
	binaryPath?: string
	/** Environment used to look for `NAMZU_ANALYSIS_NATIVE_BIN` (default `process.env`). */
	env?: NodeJS.ProcessEnv
	/** Extra command-line arguments for the sidecar (for example `--max-file-bytes`). */
	args?: readonly string[]
	/**
	 * Wall-clock limit for one request, in milliseconds (default 60 000). It is
	 * sent to the sidecar, which stops cooperatively; if the sidecar has not
	 * answered `killGraceMs` later the process is killed and replaced.
	 */
	deadlineMs?: number
	/** How long past the deadline the sidecar gets to answer before it is killed (default 2000). */
	killGraceMs?: number
	/**
	 * Largest result a request may produce, in bytes (default 4 MiB). Sent as
	 * `maxBytes`: list ops stop adding items when it is reached and say how to
	 * continue. This is the memory bound this client relies on, together with
	 * the deadline kill and the sidecar's file-size limit; see the docs.
	 */
	maxOutputBytes?: number
	/** Receives each line the sidecar writes to stderr. */
	onDiagnostic?: (line: string) => void
}

export interface RequestOptions {
	/** Overrides the client's `deadlineMs` for this request. */
	deadlineMs?: number
	/** Overrides the client's `maxOutputBytes` for this request. */
	maxBytes?: number
}

export interface NativeAnalysis {
	/** The sidecar's version, protocol, ops and limits. */
	hello(options?: RequestOptions): Promise<Hello>
	binaryInfo(params: TargetParams, options?: RequestOptions): Promise<BinaryInfo>
	symbols(params: SymbolsParams, options?: RequestOptions): Promise<SymbolsResult>
	imports(params: ImportsParams, options?: RequestOptions): Promise<ImportsResult>
	exports(params: ImportsParams, options?: RequestOptions): Promise<ExportsResult>
	strings(params: StringsParams, options?: RequestOptions): Promise<StringsResult>
	/**
	 * List, or list and write, the JavaScript a Bun or Node SEA executable
	 * carries. Writes a `.namzu-provenance.json` into `outDir` recording where it
	 * came from (source path and SHA-256, format, Bun version) unless the
	 * directory was not asked for.
	 */
	extractEmbedded(params: ExtractParams, options?: RequestOptions): Promise<ExtractedEmbedded>
	/** Send any op by name. The typed methods above are thin wrappers. */
	request<T = unknown>(
		op: NativeOp | (string & {}),
		params?: object,
		options?: RequestOptions,
	): Promise<T>
	/** Where the binary came from. */
	readonly sidecar: ResolvedSidecar
	/** Stop the process. Pending requests fail with code `closed`. Safe to call twice. */
	close(): Promise<void>
}

interface Pending {
	id: number
	op: string
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	line: string
	deadlineMs: number
	cap: number
	timer?: NodeJS.Timeout
}

const DEFAULT_DEADLINE_MS = 60_000
const DEFAULT_GRACE_MS = 2_000
const DEFAULT_MAX_OUTPUT = 4 << 20

/**
 * Spawns the sidecar lazily and speaks NDJSON to it.
 *
 * Requests are queued and sent one at a time, because the sidecar is
 * sequential. A request that outlives its deadline plus the grace period gets
 * the process killed; the next request starts a fresh one. A crash fails only
 * the request in flight.
 */
export function createNativeAnalysis(options: NativeAnalysisOptions = {}): NativeAnalysis {
	const resolved = resolveSidecar({ binaryPath: options.binaryPath, env: options.env })
	if (!resolved) {
		throw new NativeAnalysisError(
			'sidecar_not_found',
			options.binaryPath
				? `the sidecar binary ${options.binaryPath} does not exist`
				: 'the native analysis binary was not found. Install the optional package for this platform, set NAMZU_ANALYSIS_NATIVE_BIN, or run `pnpm --filter @namzu/analysis-native build` in a checkout.',
		)
	}
	const sidecar: ResolvedSidecar = resolved
	const defaultDeadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS
	const grace = options.killGraceMs ?? DEFAULT_GRACE_MS
	const defaultMaxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
	// The sidecar refuses a longer request line and answers it with `id: null`;
	// refuse it here instead, so nothing is sent that cannot be answered.
	const maxRequestBytes = requestLimit(options.args ?? [])
	// A response can be a little over maxBytes (envelope), never far over.
	const responseCap = (maxBytes: number) => maxBytes + (maxBytes >> 2) + (1 << 16)

	let child: ChildProcessWithoutNullStreams | null = null
	let stdoutBuf = ''
	let stderrTail = ''
	let nextId = 1
	let closed = false
	let inflight: Pending | null = null
	let inflightCap = responseCap(defaultMaxBytes)
	const queue: Pending[] = []
	let helloVersion = ''

	function start(): ChildProcessWithoutNullStreams {
		const proc = spawn(sidecar.path, [...(options.args ?? [])], {
			stdio: ['pipe', 'pipe', 'pipe'],
			// A crash must not drop a core file into the caller's project, and the
			// sidecar needs nothing from its environment.
			cwd: tmpdir(),
			env: { RUST_BACKTRACE: '0' },
			windowsHide: true,
		})
		stdoutBuf = ''
		stderrTail = ''
		proc.stdout.setEncoding('utf8')
		proc.stderr.setEncoding('utf8')
		proc.stdin.on('error', () => {
			// EPIPE when the process died; the exit handler reports it.
		})
		proc.stdout.on('data', (chunk: string) => onStdout(proc, chunk))
		proc.stderr.on('data', (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-2000)
			if (options.onDiagnostic) {
				for (const line of chunk.split('\n')) if (line) options.onDiagnostic(line)
			}
		})
		proc.on('error', (err) => onGone(proc, `could not start: ${err.message}`))
		// 'close', not 'exit': it fires after stderr is drained, so the message
		// carries the process's last words.
		proc.on('close', (code, signal) =>
			onGone(proc, `exited (${signal ? `signal ${signal}` : `code ${code}`})`),
		)
		child = proc
		return proc
	}

	function onStdout(proc: ChildProcessWithoutNullStreams, chunk: string): void {
		if (proc !== child) return
		stdoutBuf += chunk
		for (;;) {
			const nl = stdoutBuf.indexOf('\n')
			if (nl < 0) break
			const line = stdoutBuf.slice(0, nl)
			stdoutBuf = stdoutBuf.slice(nl + 1)
			if (line.length > inflightCap) {
				tooLarge(proc)
				return
			}
			deliver(line)
		}
		if (stdoutBuf.length > inflightCap) tooLarge(proc)
	}

	function tooLarge(proc: ChildProcessWithoutNullStreams): void {
		const pending = inflight
		discard(proc)
		if (pending) {
			settle(
				pending,
				new NativeAnalysisError(
					'response_too_large',
					`the sidecar's response for ${pending.op} passed the ${inflightCap} byte cap; it was stopped`,
					pending.op,
				),
			)
		}
		pump()
	}

	function deliver(line: string): void {
		const pending = inflight
		let msg: {
			id?: unknown
			ok?: unknown
			result?: unknown
			error?: { code?: string; message?: string }
		}
		try {
			msg = JSON.parse(line)
		} catch {
			if (pending) {
				const proc = child
				if (proc) discard(proc)
				settle(
					pending,
					new NativeAnalysisError(
						'protocol_error',
						'the sidecar wrote a line that is not JSON',
						pending.op,
					),
				)
				pump()
			}
			return
		}
		if (pending && msg.id === null && msg.ok === false) {
			// The sidecar could not attribute the failure to a request (an over-long
			// line, invalid JSON): it answers with a null id. Only one request is in
			// flight, so this one is it; waiting out the deadline would strand it.
			settle(
				pending,
				new NativeAnalysisError(
					msg.error?.code ?? 'protocol_error',
					msg.error?.message ?? 'the sidecar rejected the request without naming it',
					pending.op,
				),
			)
			pump()
			return
		}
		if (!pending || msg.id !== pending.id) {
			// A response nobody is waiting for: drop it. It is stale or unsolicited.
			return
		}
		if (msg.ok === true) {
			settle(pending, undefined, msg.result)
		} else {
			settle(
				pending,
				new NativeAnalysisError(
					msg.error?.code ?? 'protocol_error',
					msg.error?.message ?? 'the sidecar reported an error without a message',
					pending.op,
				),
			)
		}
		pump()
	}

	/** Forget `proc` and kill it. */
	function discard(proc: ChildProcessWithoutNullStreams): void {
		if (child === proc) child = null
		proc.stdout.removeAllListeners('data')
		try {
			proc.kill('SIGKILL')
		} catch {
			// already gone
		}
	}

	function onGone(proc: ChildProcessWithoutNullStreams, how: string): void {
		if (proc !== child) return
		child = null
		const pending = inflight
		if (pending) {
			const tail = stderrTail.trim()
			settle(
				pending,
				new NativeAnalysisError(
					'sidecar_exited',
					`the native analysis process ${how} while handling ${pending.op}${tail ? `: ${tail}` : ''}`,
					pending.op,
				),
			)
		}
		pump()
	}

	function settle(pending: Pending, error?: Error, value?: unknown): void {
		if (inflight !== pending) return
		inflight = null
		if (pending.timer) clearTimeout(pending.timer)
		if (error) pending.reject(error)
		else pending.resolve(value)
	}

	function pump(): void {
		if (inflight || queue.length === 0) return
		if (closed) {
			for (const p of queue.splice(0)) {
				p.reject(new NativeAnalysisError('closed', 'the native analysis client is closed', p.op))
			}
			return
		}
		const next = queue.shift()
		if (!next) return
		inflight = next
		inflightCap = next.cap
		let proc: ChildProcessWithoutNullStreams
		try {
			proc = child ?? start()
		} catch (err) {
			settle(
				next,
				new NativeAnalysisError(
					'sidecar_exited',
					`could not start the native analysis process: ${(err as Error).message}`,
					next.op,
				),
			)
			pump()
			return
		}
		next.timer = setTimeout(() => {
			if (inflight !== next) return
			const dead = child
			if (dead) discard(dead)
			settle(
				next,
				new NativeAnalysisError(
					'deadline_exceeded',
					`${next.op} did not finish within ${next.deadlineMs} ms; the process was stopped`,
					next.op,
				),
			)
			pump()
		}, next.deadlineMs + grace)
		next.timer.unref?.()
		proc.stdin.write(`${next.line}\n`)
	}

	function request<T>(op: string, params: object = {}, ro: RequestOptions = {}): Promise<T> {
		if (closed) {
			return Promise.reject(
				new NativeAnalysisError('closed', 'the native analysis client is closed', op),
			)
		}
		const deadlineMs = ro.deadlineMs ?? defaultDeadline
		const maxBytes = ro.maxBytes ?? defaultMaxBytes
		const id = nextId++
		const normalised = absolutise(params)
		const line = JSON.stringify({ id, op, params: normalised, deadlineMs, maxBytes })
		const lineBytes = Buffer.byteLength(line) + 1
		if (lineBytes > maxRequestBytes) {
			return Promise.reject(
				new NativeAnalysisError(
					'request_too_large',
					`the ${op} request is ${lineBytes} bytes, over the ${maxRequestBytes} byte request limit; it was not sent`,
					op,
				),
			)
		}
		return new Promise<T>((resolve, reject) => {
			queue.push({
				id,
				op,
				line,
				deadlineMs,
				cap: responseCap(maxBytes),
				resolve: resolve as (v: unknown) => void,
				reject,
			})
			pump()
		})
	}

	const api: NativeAnalysis = {
		sidecar,
		request,
		hello: async (o) => {
			const h = await request<Hello>('hello', {}, o)
			helloVersion = h.version
			return h
		},
		binaryInfo: (p, o) => request('binary_info', p, o),
		symbols: (p, o) => request('symbols', p, o),
		imports: (p, o) => request('imports', p, o),
		exports: (p, o) => request('exports', p, o),
		strings: (p, o) => request('strings', p, o),
		extractEmbedded: async (p, o) => {
			const result = await request<ExtractedEmbedded>('extract_embedded', p, o)
			if (!helloVersion) helloVersion = (await api.hello(o)).version
			result.embeddedProvenance = {
				sourcePath: resolvePath(p.path),
				sourceSha256: result.provenance.sourceSha256,
				sourceSize: result.provenance.sourceSize,
				format: result.provenance.format,
				kind: result.kind,
				bunVersion: result.bunVersion ?? null,
				layout: result.layout ?? null,
				sidecarVersion: helloVersion,
			}
			if (result.outDir) {
				await writeFile(
					join(result.outDir, '.namzu-provenance.json'),
					`${JSON.stringify(result.embeddedProvenance, null, 2)}\n`,
					{ flag: 'wx' },
				)
			}
			return result
		},
		close: async () => {
			closed = true
			const proc = child
			if (proc) {
				// `exitCode`/`signalCode` are set once the process has exited, so a
				// process that already did is not waited for (its event has fired).
				const exited =
					proc.exitCode !== null || proc.signalCode !== null
						? Promise.resolve()
						: new Promise<void>((done) => proc.once('exit', () => done()))
				discard(proc)
				await exited
			}
			const pending = inflight
			if (pending) {
				settle(
					pending,
					new NativeAnalysisError('closed', 'the native analysis client was closed', pending.op),
				)
			}
			pump()
		},
	}
	return api
}

const DEFAULT_MAX_REQUEST = 1 << 20

/** The request limit the sidecar will run with: its default, or `--max-request-bytes`. */
function requestLimit(args: readonly string[]): number {
	let limit = DEFAULT_MAX_REQUEST
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === '--max-request-bytes') {
			const n = Number(args[i + 1])
			if (Number.isSafeInteger(n) && n > 0) limit = n
		}
	}
	return limit
}

/** Paths are resolved against the caller's working directory, not the sidecar's. */
function absolutise(params: object): object {
	const p = { ...(params as Record<string, unknown>) }
	for (const key of ['path', 'outDir']) {
		if (typeof p[key] === 'string' && p[key] !== '') p[key] = resolvePath(p[key] as string)
	}
	return p
}
