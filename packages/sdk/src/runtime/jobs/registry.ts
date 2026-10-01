import { spawn } from 'node:child_process'

import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { killTree } from '../../process/kill-tree.js'
import { hostShellSpawn } from '../../tools/command-shell.js'
import { scrubInheritedEnv } from '../../tools/env-scrub.js'
import type {
	BackgroundJobOutputWaitOptions,
	BackgroundJobOutputWaitResult,
} from '../../types/job/index.js'
import { subscribeToAbort } from '../../utils/abort.js'

/**
 * Work that outlives a tool call, owned by whoever started it.
 *
 * `bash` had no background mode, and the reason it could not simply grow one
 * is recorded in the commit that removed the suggestion from its schema: on
 * the `linux-namespace` isolation tier the wrapping `sh` is PID 1 of a fresh
 * PID namespace, the kernel destroys a PID namespace when its init exits,
 * and a backgrounded grandchild goes with it. `sh -c "long-thing & echo go"`
 * therefore returns in milliseconds looking like it worked, with the work
 * already dead — on the SUCCESSFUL path, not on timeout or abort.
 *
 * So backgrounding cannot be delegated to the shell. **This registry holds
 * the process itself**, for its whole life, which is what keeps the
 * namespace alive and gives the job an identity to poll, output to read, and
 * an owner to be torn down with.
 *
 * Every bound here is a refusal rather than a silent adjustment, and the
 * output cap reports what it dropped. A background job whose tail vanished
 * quietly is worse than one that was refused: the model reads it as the
 * whole output and concludes the build passed.
 */

export type BackgroundJobStatus = 'running' | 'exited' | 'killed'

export interface BackgroundJob {
	readonly id: string
	/** Whoever the job dies with — a turn id, or the session id for a job bound to the session. */
	readonly owner: string
	readonly command: string
	readonly status: BackgroundJobStatus
	readonly startedAt: number
	readonly exitedAt?: number
	readonly exitCode?: number
	readonly signal?: string
}

export interface BackgroundJobOutput {
	readonly chunk: string
	/**
	 * Pass back as `fromOffset` to continue. Counted in bytes over the whole
	 * stream INCLUDING what the cap dropped, so a caller polling in a loop
	 * cannot silently re-read or skip.
	 */
	readonly nextOffset: number
	/**
	 * Bytes the cap discarded before `chunk`. Never silent: a job whose tail
	 * vanished quietly reads as a complete result that happens to be short.
	 */
	readonly droppedBytes: number
	readonly status: BackgroundJobStatus
	readonly exitCode?: number
}

/** A job's process, when something other than the registry starts it. */
export interface JobProcess {
	readonly child: ReturnType<typeof spawn>
	/** How to stop it, when the registry's process-group kill would not reach everything. */
	kill?(signal: NodeJS.Signals): void
}

export interface StartJobParams {
	readonly owner: string
	readonly command: string
	readonly workingDirectory: string
	readonly env?: Readonly<Record<string, string>>
	/**
	 * Start the process yourself — a sandbox does, so the job runs inside
	 * its boundary. Absent, the registry runs it on the
	 * host in the `bash` tool's shell (`tools/command-shell.ts`). The process must be the leader of its own group and must not
	 * expect stdin.
	 */
	readonly spawn?: () => JobProcess
}

export interface BackgroundJobRegistryConfig {
	/**
	 * Refused past this many LIVE jobs for one owner.
	 *
	 * Per owner rather than global: one turn spawning a hundred watchers must
	 * not be able to refuse a different turn its first.
	 */
	readonly maxJobsPerOwner?: number
	/** Retained output per job. Oldest bytes go first, and are counted. */
	readonly maxOutputBytesPerJob?: number
	/** Concurrent output observers per owner; default 32. Refused rather than queued. */
	readonly maxOutputWaitersPerOwner?: number
	/** Concurrent output observers across the registry; default 256. */
	readonly maxOutputWaiters?: number
}

const DEFAULT_MAX_JOBS_PER_OWNER = 8
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_CHANNEL_CHUNKS = 4096
const MAX_WAIT_RESULT_BYTES = 32 * 1024
const MAX_OUTPUT_WAIT_MS = 60 * 60 * 1000

/** Starting another observer would exceed its owner's or registry's bound. */
export class BackgroundJobOutputWaitLimitError extends Error {
	constructor(readonly details: { owner: string; limit: number; scope: 'owner' | 'registry' }) {
		super(
			`Background output wait limit ${details.limit} reached for ${details.scope}; finish or cancel an existing wait first.`,
		)
		this.name = 'BackgroundJobOutputWaitLimitError'
	}
}

interface OutputChunk {
	readonly stream: 'stdout' | 'stderr'
	readonly offset: number
	readonly bytes: Buffer
}

/** Start at a complete UTF-8 code point when a byte cap or cursor bisects one. */
function utf8Start(bytes: Buffer, start: number): number {
	let at = start
	while (at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) at++
	return at
}

function outputTail(text: string, maxBytes: number): { text: string; omitted: number } {
	const bytes = Buffer.from(text)
	if (bytes.length <= maxBytes) return { text, omitted: 0 }
	const start = utf8Start(bytes, bytes.length - maxBytes)
	return { text: bytes.subarray(start).toString('utf8'), omitted: start }
}

/** A start that would exceed a declared bound. */
export class BackgroundJobLimitError extends Error {
	readonly details: { owner: string; limit: number }

	constructor(details: { owner: string; limit: number }) {
		super(
			`Owner ${details.owner} already has ${details.limit} running background jobs; kill one before starting another.`,
		)
		this.name = 'BackgroundJobLimitError'
		this.details = details
	}
}

/** An id nothing in this registry knows. */
export class UnknownBackgroundJobError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`No background job ${details.id}.`)
		this.name = 'UnknownBackgroundJobError'
		this.details = details
	}
}

interface JobEntry {
	record: BackgroundJob
	child: ReturnType<typeof spawn>
	/** The spawner's own kill, when it gave one. */
	killProcess?: (signal: NodeJS.Signals) => void
	/** Retained tail. */
	buffer: string
	/** Bytes produced in total, including the ones the cap dropped. */
	produced: number
	/** Channel identity is retained separately, under the same byte cap and a chunk cap. */
	outputChunks: OutputChunk[]
	outputObservers: Set<(chunk?: OutputChunk) => void>
	exit: Promise<void>
}

/** Whether any process of the group led by `pid` is still alive. */
function groupAlive(pid: number | undefined): boolean {
	if (pid === undefined || process.platform === 'win32') return false
	try {
		process.kill(-pid, 0)
		return true
	} catch {
		return false
	}
}

const GROUP_POLL_MS = 250

export class BackgroundJobRegistry {
	private readonly jobs = new Map<string, JobEntry>()
	private counter = 0
	private readonly exitListeners = new Set<(job: BackgroundJob) => void>()
	private outputWaiters = 0
	private readonly outputWaitersByOwner = new Map<string, number>()

	/**
	 * Be told when a job ends, whoever owns it. A job outlives the call that
	 * started it, so the one thing the model could not do was learn that it
	 * had finished without polling; a turn subscribes here and turns the exit
	 * into a notice on its next tool result. Returns the unsubscribe.
	 */
	onExit(listener: (job: BackgroundJob) => void): () => void {
		this.exitListeners.add(listener)
		return () => {
			this.exitListeners.delete(listener)
		}
	}

	private announceExit(job: BackgroundJob): void {
		for (const listener of this.exitListeners) {
			try {
				listener(job)
			} catch {
				// A listener that throws is its owner's problem, not the job's.
			}
		}
	}

	constructor(private readonly config: BackgroundJobRegistryConfig = {}) {
		for (const key of ['maxOutputWaiters', 'maxOutputWaitersPerOwner'] as const) {
			const value = config[key]
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
				throw new RangeError(`${key} must be a positive safe integer.`)
			}
		}
	}

	private get maxJobs(): number {
		return this.config.maxJobsPerOwner ?? DEFAULT_MAX_JOBS_PER_OWNER
	}

	private get maxBytes(): number {
		return this.config.maxOutputBytesPerJob ?? DEFAULT_MAX_OUTPUT_BYTES
	}

	/** Live jobs for one owner, oldest first. */
	list(owner: string): readonly BackgroundJob[] {
		return [...this.jobs.values()]
			.filter((entry) => entry.record.owner === owner)
			.map((entry) => entry.record)
	}

	start(params: StartJobParams): BackgroundJob {
		const running = this.list(params.owner).filter((job) => job.status === 'running')
		if (running.length >= this.maxJobs) {
			// Refused, not queued. A queue would accept the call and start the
			// work minutes later against a turn that has since ended — the model
			// would be told its job is running and poll an id that does nothing.
			throw new BackgroundJobLimitError({ owner: params.owner, limit: this.maxJobs })
		}

		this.counter += 1
		const id = `job_${this.counter}`
		// Same scrub as the foreground path: inheritance is implicit, so the
		// operator's provider credentials do not travel into a command nobody
		// decided should see them. A background job outlives the call that
		// started it, which makes the leak longer-lived, not smaller.
		const inherited = scrubInheritedEnv()

		// The same shell as a foreground `bash` call, so the permission
		// rules' reading of the line holds for the job too.
		const shell = hostShellSpawn(params.command, { ...inherited.env, ...params.env })
		const started = params.spawn
			? params.spawn()
			: {
					child: spawn(
						shell.file ?? '/bin/sh',
						shell.file === undefined ? ['-c', params.command] : [...shell.args],
						{
							cwd: params.workingDirectory,
							env: shell.env,
							// Leader of its own process group, which is what `killTree` needs
							// to reach the command and everything it forks rather than only the
							// wrapping shell. See `process/kill-tree.ts`.
							detached: process.platform !== 'win32',
							stdio: ['ignore', 'pipe', 'pipe'],
						},
					),
				}
		const child = started.child
		// Started, not adopted: this process stays the parent for the job's
		// whole life. `unref` would let Node exit with the job still running,
		// which is the orphan this registry exists to prevent.
		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')

		const entry: JobEntry = {
			record: {
				id,
				owner: params.owner,
				command: params.command,
				status: 'running',
				startedAt: Date.now(),
			},
			child,
			...(started.kill ? { killProcess: started.kill.bind(started) } : {}),
			buffer: '',
			produced: 0,
			outputChunks: [],
			outputObservers: new Set(),
			exit: new Promise<void>((resolve) => {
				let spawned = child.pid !== undefined
				let failedToSpawn = false
				const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
					entry.record = {
						...entry.record,
						// A job killed by this registry says `killed`, not
						// `exited` with a signal a reader has to interpret. The
						// two are different answers to "why did my job stop".
						status: entry.record.status === 'killed' ? 'killed' : 'exited',
						exitedAt: Date.now(),
						...(code === null ? {} : { exitCode: code }),
						...(signal ? { signal } : {}),
					}
					resolve()
					for (const observer of entry.outputObservers) observer()
					this.announceExit(entry.record)
				}
				child.once('spawn', () => {
					spawned = true
				})
				child.on('error', () => {
					// A failed spawn emits both `error` and `close`. Waiting for
					// `close` also covers errors on an already-running process
					// (such as a failed kill) without announcing a false exit.
					if (!spawned) failedToSpawn = true
				})
				child.once('close', (code, signal) => {
					// The job is the process GROUP, not the shell. A command that
					// backgrounds its real work (`server &`) exits the shell at
					// once and leaves the server as the group's survivor; calling
					// that "exited" told the model the job was over while the
					// port was still held, and nothing stopped the survivor at
					// session end because the job was no longer running. So a
					// job whose shell has ended stays running while its group is
					// alive, and ends — with the shell's exit code — when the
					// group is empty.
					const exitCode = failedToSpawn ? null : code
					if (entry.record.status !== 'killed' && groupAlive(child.pid)) {
						const poll = setInterval(() => {
							if (groupAlive(child.pid)) return
							clearInterval(poll)
							finalize(exitCode, signal)
						}, GROUP_POLL_MS)
						poll.unref()
						return
					}
					finalize(exitCode, signal)
				})
			}),
		}

		const append = (text: string, stream: 'stdout' | 'stderr'): void => {
			const chunk: OutputChunk = { stream, offset: entry.produced, bytes: Buffer.from(text) }
			if (chunk.bytes.length === 0) return
			entry.produced += chunk.bytes.length
			entry.buffer += text
			entry.buffer = outputTail(entry.buffer, this.maxBytes).text
			entry.outputChunks.push(chunk)
			const retainedStart = entry.produced - Buffer.byteLength(entry.buffer)
			while (
				entry.outputChunks.length > MAX_CHANNEL_CHUNKS ||
				(entry.outputChunks[0] &&
					entry.outputChunks[0].offset + entry.outputChunks[0].bytes.length <= retainedStart)
			) {
				entry.outputChunks.shift()
			}
			const first = entry.outputChunks[0]
			if (first && first.offset < retainedStart) {
				const skip = utf8Start(first.bytes, retainedStart - first.offset)
				entry.outputChunks[0] = {
					...first,
					offset: first.offset + skip,
					bytes: Buffer.from(first.bytes.subarray(skip)),
				}
			}
			// Deliver the actual chunk even when its beginning has already fallen
			// outside retention: an active observer must not miss a fast producer.
			for (const observer of entry.outputObservers) observer(chunk)
		}
		child.stdout?.on('data', (text: string) => append(text, 'stdout'))
		child.stderr?.on('data', (text: string) => append(text, 'stderr'))

		this.jobs.set(id, entry)
		return entry.record
	}

	/** The record, or throw for an id this registry does not know. */
	get(id: string): BackgroundJob {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		return entry.record
	}

	/**
	 * Await one job's exit — the public counterpart to `onExit`, for a
	 * caller that wants a single result rather than a standing
	 * subscription. Resolves at once for a job that has already stopped, so
	 * a caller that lost the race against a fast-finishing job never blocks
	 * on a promise that would otherwise never settle.
	 *
	 * `signal` is honoured: an aborted wait rejects and detaches rather than
	 * holding the internal exit promise's continuation open for a job that
	 * may run for another hour. That only ends the WAIT — the job itself is
	 * untouched either way, exactly as a timed-out `kill`-less wait leaves
	 * it. See `wait-for-job-bounds.ts`, the first caller.
	 */
	waitForExit(id: string, opts: { signal?: AbortSignal } = {}): Promise<BackgroundJob> {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		if (entry.record.status !== 'running') return Promise.resolve(entry.record)
		if (!opts.signal) {
			// Keep the original promise path for callers without cancellation.
			return entry.exit.then(() => entry.record)
		}
		const signal = opts.signal
		if (signal.aborted) return Promise.reject(signal.reason)

		// A Promise.race against entry.exit leaves a continuation on that
		// never-ending promise after cancellation. An exit listener can instead
		// be removed as soon as this particular wait is abandoned.
		return new Promise<BackgroundJob>((resolve, reject) => {
			let disposeAbort = () => {}
			const unsubscribe = this.onExit((job) => {
				if (job.id !== id) return
				unsubscribe()
				disposeAbort()
				resolve(job)
			})
			disposeAbort = subscribeToAbort(signal, () => {
				unsubscribe()
				disposeAbort()
				reject(signal.reason)
			})
		})
	}

	/**
	 * Observe a literal in one pipe, including retained output after the cursor.
	 * A marker is evidence of output, not exit intent or service health. Every
	 * observer is independent and bounded; cancellation never stops the job.
	 */
	waitForOutput(
		id: string,
		opts: BackgroundJobOutputWaitOptions,
	): Promise<BackgroundJobOutputWaitResult> {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		// Capture the admitted condition and clocks once; a caller retaining its
		// mutable options object cannot alter a bound after validation.
		const {
			literal: literalText,
			stream: requestedStream,
			fromOffset,
			timeoutMs,
			idleTimeoutMs,
			signal,
		} = opts
		if (
			typeof literalText !== 'string' ||
			literalText.length === 0 ||
			Buffer.byteLength(literalText) > 4096 ||
			Buffer.from(literalText).toString('utf8') !== literalText
		) {
			throw new RangeError('Output literal must be non-empty valid UTF-8, at most 4096 bytes.')
		}
		const stream = requestedStream ?? 'either'
		if (!['stdout', 'stderr', 'either'].includes(stream))
			throw new RangeError('Unknown output stream.')
		for (const [name, value] of [
			['timeoutMs', timeoutMs],
			['idleTimeoutMs', idleTimeoutMs],
		] as const) {
			if (
				(name === 'timeoutMs' || value !== undefined) &&
				(value === undefined ||
					!Number.isSafeInteger(value) ||
					value < 1 ||
					value > MAX_OUTPUT_WAIT_MS)
			) {
				throw new RangeError(`${name} must be an integer from 1 through ${MAX_OUTPUT_WAIT_MS}.`)
			}
		}
		const from = fromOffset ?? 0
		if (!Number.isSafeInteger(from) || from < 0 || from > entry.produced) {
			throw new RangeError('fromOffset must be an observed, nonnegative output byte cursor.')
		}
		const literal = Buffer.from(literalText)
		const suffix = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
		const match = (chunk: OutputChunk): 'stdout' | 'stderr' | undefined => {
			if (
				(stream !== 'either' && stream !== chunk.stream) ||
				chunk.offset + chunk.bytes.length <= from
			)
				return
			const skip = utf8Start(chunk.bytes, Math.max(0, from - chunk.offset))
			const bytes = Buffer.concat([suffix[chunk.stream], chunk.bytes.subarray(skip)])
			const found = bytes.indexOf(literal) !== -1
			// Only the bytes that can prefix a future match survive each chunk.
			// Copy so a tiny suffix never retains a large producer buffer.
			suffix[chunk.stream] = Buffer.from(
				bytes.subarray(Math.max(0, bytes.length - literal.length + 1)),
			)
			return found ? chunk.stream : undefined
		}
		let output = ''
		let cursor = from
		let droppedBytes = 0
		let omittedOutputBytes = 0
		const read = (): void => {
			const observed = this.read(id, { fromOffset: cursor })
			cursor = observed.nextOffset
			droppedBytes += observed.droppedBytes
			const tail = outputTail(output + observed.chunk, MAX_WAIT_RESULT_BYTES)
			output = tail.text
			omittedOutputBytes += tail.omitted
		}
		read()
		const retainedStart = entry.produced - Buffer.byteLength(entry.buffer)
		const searchableStart = entry.outputChunks[0]?.offset ?? entry.produced
		const unsearchedBytes = Math.max(0, searchableStart - Math.max(from, retainedStart))
		const progress = () => ({
			status: entry.record.status,
			...(entry.record.exitCode === undefined ? {} : { exitCode: entry.record.exitCode }),
			output,
			nextOffset: cursor,
			droppedBytes,
			unsearchedBytes,
			omittedOutputBytes,
		})
		if (signal?.aborted) return Promise.resolve({ ...progress(), kind: 'aborted' })
		// Check synchronously before subscribing. No process event can intervene
		// in this call stack, so even a marker printed before activation is seen.
		for (const chunk of entry.outputChunks) {
			const matchedStream = match(chunk)
			if (matchedStream) return Promise.resolve({ ...progress(), kind: 'matched', matchedStream })
		}
		if (entry.record.status !== 'running') {
			return Promise.resolve({
				...progress(),
				kind: entry.record.status === 'killed' ? 'stopped' : 'exited',
			})
		}
		const owner = entry.record.owner
		const ownerCount = this.outputWaitersByOwner.get(owner) ?? 0
		const ownerLimit = this.config.maxOutputWaitersPerOwner ?? 32
		const globalLimit = this.config.maxOutputWaiters ?? 256
		if (ownerCount >= ownerLimit)
			throw new BackgroundJobOutputWaitLimitError({ owner, limit: ownerLimit, scope: 'owner' })
		if (this.outputWaiters >= globalLimit)
			throw new BackgroundJobOutputWaitLimitError({ owner, limit: globalLimit, scope: 'registry' })
		this.outputWaiters++
		this.outputWaitersByOwner.set(owner, ownerCount + 1)
		return new Promise((resolve) => {
			const startedAt = Date.now()
			let settled = false
			let disposeAbort = () => {}
			let idleTimer: ReturnType<typeof setTimeout> | undefined
			const finish = (result: BackgroundJobOutputWaitResult): void => {
				if (settled) return
				settled = true
				entry.outputObservers.delete(observe)
				clearTimeout(wallTimer)
				clearTimeout(idleTimer)
				disposeAbort()
				this.outputWaiters--
				const remaining = (this.outputWaitersByOwner.get(owner) ?? 1) - 1
				if (remaining === 0) this.outputWaitersByOwner.delete(owner)
				else this.outputWaitersByOwner.set(owner, remaining)
				resolve(result)
			}
			const timeout = (cause: 'wall' | 'idle'): void => {
				read()
				finish({ ...progress(), kind: 'timeout', cause, elapsedMs: Date.now() - startedAt })
			}
			const resetIdle = (): void => {
				if (idleTimeoutMs === undefined) return
				clearTimeout(idleTimer)
				idleTimer = setTimeout(() => timeout('idle'), idleTimeoutMs)
				idleTimer.unref?.()
			}
			const observe = (chunk?: OutputChunk): void => {
				read()
				const matchedStream = chunk ? match(chunk) : undefined
				if (matchedStream) finish({ ...progress(), kind: 'matched', matchedStream })
				else if (entry.record.status !== 'running') {
					finish({ ...progress(), kind: entry.record.status === 'killed' ? 'stopped' : 'exited' })
				} else if (chunk) resetIdle()
			}
			entry.outputObservers.add(observe)
			const wallTimer = setTimeout(() => timeout('wall'), timeoutMs)
			wallTimer.unref?.()
			resetIdle()
			if (signal)
				disposeAbort = subscribeToAbort(signal, () => {
					read()
					finish({ ...progress(), kind: 'aborted' })
				})
		})
	}

	/**
	 * Output since `fromOffset`, with what the cap dropped stated.
	 *
	 * Offsets count the whole stream rather than the retained buffer, so a
	 * poller that falls behind the cap is TOLD it fell behind instead of
	 * being handed a seamless-looking excerpt.
	 */
	read(id: string, opts: { fromOffset?: number } = {}): BackgroundJobOutput {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })

		const bufferStart = entry.produced - Buffer.byteLength(entry.buffer)
		const from = opts.fromOffset ?? 0
		// A caller behind the cap resumes at the oldest byte still held, and
		// the gap is reported rather than closed over.
		const effective = Math.max(from, bufferStart)
		const skip = Math.max(0, effective - bufferStart)
		const bytes = Buffer.from(entry.buffer)
		const aligned = utf8Start(bytes, skip)
		const chunk = bytes.subarray(aligned).toString('utf8')

		return {
			chunk,
			nextOffset: entry.produced,
			droppedBytes: Math.max(0, effective - from) + Math.max(0, aligned - skip),
			status: entry.record.status,
			...(entry.record.exitCode === undefined ? {} : { exitCode: entry.record.exitCode }),
		}
	}

	/** SIGTERM the tree, then SIGKILL after the shared grace period. */
	async kill(id: string): Promise<BackgroundJob> {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		if (entry.record.status !== 'running') return entry.record

		// Marked before the signal, so the `close` handler that follows can
		// tell a kill from an ordinary exit. Set it after and the race decides
		// which of two different answers a reader gets.
		entry.record = { ...entry.record, status: 'killed' }
		for (const observer of entry.outputObservers) observer()
		const signal = (sig: NodeJS.Signals) =>
			entry.killProcess ? entry.killProcess(sig) : killTree(entry.child, sig)
		signal('SIGTERM')
		const grace = setTimeout(() => signal('SIGKILL'), SANDBOX_KILL_GRACE_MS)
		// Unreffed: a job that exits on SIGTERM must not hold the process open
		// for the remaining grace period doing nothing.
		grace.unref?.()
		try {
			await entry.exit
		} finally {
			clearTimeout(grace)
		}
		return entry.record
	}

	/**
	 * Kill everything one owner started.
	 *
	 * The teardown call. Without it a turn that ends leaves its jobs running
	 * with nothing left that knows their ids — the orphan this whole module
	 * exists to make impossible.
	 */
	async killOwner(owner: string): Promise<readonly BackgroundJob[]> {
		const mine = this.list(owner).filter((job) => job.status === 'running')
		return await Promise.all(mine.map((job) => this.kill(job.id)))
	}

	/** Drop the record for a job that has already stopped. */
	forget(id: string): void {
		const entry = this.jobs.get(id)
		if (!entry) return
		if (entry.record.status === 'running') {
			// Forgetting a live job is how it becomes an orphan: the process
			// keeps running and the id that could have killed it is gone.
			throw new Error(`Job ${id} is still running; kill it before forgetting it.`)
		}
		this.jobs.delete(id)
	}
}

/**
 * One owner's view of the registry.
 *
 * The owner is bound here rather than passed by the caller, which is the
 * whole point: a tool holding this cannot start a job billed to somebody
 * else's turn, nor read or kill one. `list` and the lookups are filtered to
 * the same owner, so an id from another turn reads as unknown — the same
 * answer the tenant checks give elsewhere in this tree, and for the same
 * reason.
 */
export function bindOwner(
	registry: BackgroundJobRegistry,
	owner: string,
	defaults: {
		readonly workingDirectory?: string
		readonly env?: Record<string, string>
		/** See `StartJobParams.spawn`; given the resolved command, directory and env. */
		readonly spawn?: (params: {
			readonly command: string
			readonly workingDirectory: string
			readonly env?: Record<string, string>
		}) => JobProcess
		/**
		 * Be told that the model said it is waiting on a job's exit.
		 *
		 * The registry does not keep this: wait-intent belongs to the TURN that
		 * expressed it, not to a registry a host may share across turns and
		 * sessions. The turn passes its own recorder here — `AwaitedJobs`, which
		 * is what the iteration loop holds open for. Absent means nobody is
		 * listening, and `markAwaited` is then absent from the bound ref rather
		 * than present and silently doing nothing.
		 */
		readonly onAwaited?: (id: string) => void
	} = {},
) {
	const mine = (id: string): BackgroundJob => {
		const job = registry.get(id)
		if (job.owner !== owner) throw new UnknownBackgroundJobError({ id })
		return job
	}
	return {
		start: (params: { command: string; workingDirectory?: string }) => {
			const workingDirectory = params.workingDirectory ?? defaults.workingDirectory ?? process.cwd()
			const spawnHost = defaults.spawn
			return registry.start({
				owner,
				command: params.command,
				workingDirectory,
				...(defaults.env ? { env: defaults.env } : {}),
				...(spawnHost
					? {
							spawn: () =>
								spawnHost({
									command: params.command,
									workingDirectory,
									...(defaults.env ? { env: defaults.env } : {}),
								}),
						}
					: {}),
			})
		},
		get: (id: string) => mine(id),
		read: (id: string, opts?: { fromOffset?: number }) => {
			mine(id)
			return registry.read(id, opts ?? {})
		},
		waitForExit: (id: string, opts?: { signal?: AbortSignal }) => {
			mine(id)
			return registry.waitForExit(id, opts ?? {})
		},
		waitForOutput: (id: string, opts: BackgroundJobOutputWaitOptions) => {
			mine(id)
			return registry.waitForOutput(id, opts)
		},
		...(defaults.onAwaited
			? {
					markAwaited: (id: string) => {
						mine(id)
						defaults.onAwaited?.(id)
					},
				}
			: {}),
		kill: async (id: string) => {
			mine(id)
			return await registry.kill(id)
		},
		list: () => registry.list(owner),
	}
}
