import type { spawn } from 'node:child_process'

import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { killTree } from '../../process/kill-tree.js'
import { describeSpawnFailure, spawnHostShell } from '../../tools/command-shell.js'
import { scrubInheritedEnv } from '../../tools/env-scrub.js'
import { createHostOutputDecoder } from '../../tools/host-output.js'
import type {
	BackgroundJobOutputWaitOptions,
	BackgroundJobOutputWaitResult,
} from '../../types/job/index.js'
import type { MonitorWebSocketTarget } from '../../types/tool/index.js'
import { subscribeToAbort } from '../../utils/abort.js'
import { oneMetadataLine } from '../system-events.js'
import { createBackgroundJobId } from './job-id.js'
import {
	MONITOR_TIMEOUT_CAP_MS,
	type MonitorStreamStats,
	createMonitorStream,
	expiryNotice,
	tooMuchOutputNotice,
} from './monitor-stream.js'
import { connectWebSocketSource, webSocketJobCommand } from './websocket-source.js'

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
	/**
	 * Why the command never started, in words for the model: set when the
	 * process could not be spawned at all (missing shell, bad working
	 * directory). Such a job has no `exitCode`; it is not a command that
	 * ran and returned a status.
	 */
	readonly error?: string
	/** Stopping the owned tree failed; the job remains owned and counted as live. */
	readonly recoveryRequired?: boolean
	/** Safe registry diagnostic for an unconfirmed stop; excludes transport secrets. */
	readonly stopError?: string
	/**
	 * `monitor` for a job started by the `monitor` tool: its stdout is
	 * delivered line by line as events, and it expires. Absent for every
	 * other job.
	 */
	readonly kind?: 'monitor'
	/** What the monitor watches, in the model's words; shown with every event. */
	readonly description?: string
	/** When the monitor will be stopped if the command has not ended first (epoch ms). */
	readonly expiresAt?: number
	/**
	 * Why a monitor was stopped, when the registry stopped it: `expired` at
	 * its deadline, `too_much_output` when the source outran the event
	 * ration, `stopped` for a `kill()` asked for from outside. Absent while it
	 * runs and when the command ended on its own.
	 */
	readonly stopReason?: 'expired' | 'too_much_output' | 'stopped'
	/**
	 * What the monitor's source is, when it is not a command: `websocket` for a
	 * monitor of a WebSocket connection, whose `command` is then
	 * `websocket <url>` and which has no exit code of a process.
	 */
	readonly transport?: 'websocket'
	/** The close code and reason the server ended a WebSocket connection with, if it did. */
	readonly closeCode?: number
	readonly closeReason?: string
}

/**
 * One thing a monitor has to say: a batch of its stdout lines, or a notice
 * from the monitor itself (events suppressed, stopped, expired).
 */
export interface MonitorEvent {
	/** `${jobId}:${seq}`, unique per registry and stable, so a host can acknowledge it. */
	readonly id: string
	readonly jobId: string
	readonly owner: string
	readonly description: string
	readonly kind: 'output' | 'notice'
	readonly text: string
	readonly at: number
	/** Set when the source is a WebSocket connection, whose text the server wrote. */
	readonly transport?: 'websocket'
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
	/** Set when the command could not be started; see {@link BackgroundJob.error}. */
	readonly error?: string
}

/**
 * What a `spawn` that is not a child process hands the registry: the few
 * members of {@link JobChild} and how to stop it. A {@link JobProcess} is one
 * too, so a `spawn` may return either.
 */
export interface JobSource {
	readonly child: JobChild
	/** How to stop it, when the registry's process-group kill would not reach everything. */
	kill?(signal: NodeJS.Signals): void
	/** Confirm the owned tree stopped; reject instead of claiming an unconfirmed exit. */
	terminate?(signal?: NodeJS.Signals): Promise<void>
}

/**
 * What the registry reads of a job's process, and nothing more.
 *
 * A `ChildProcess` satisfies it, and so does anything else that writes bytes
 * on two pipes and ends: a WebSocket connection held as a monitor's source is
 * such a thing. Named so that the registry's contract is the few members it
 * uses and not a type from `node:child_process` it would have to be cast to.
 */
export interface JobChild {
	readonly pid?: number | undefined
	readonly stdout?: JobPipe | null
	readonly stderr?: JobPipe | null
	once(event: 'spawn', listener: () => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	once(
		event: 'close',
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): unknown
}

/** A readable stream, as far as the registry reads one. */
export interface JobPipe {
	on(event: 'data', listener: (data: Buffer | string) => void): unknown
}

/**
 * What a process can say to the registry besides its output, handed to the
 * `spawn` that asked for it.
 */
export interface JobHost {
	/**
	 * Something the SOURCE has to say, delivered to a monitor's listeners as a
	 * `notice` event and never rationed as output is. `final` ends the stream:
	 * what is pending goes out first, and nothing the process writes after the
	 * notice is delivered. Ignored for a job that is not a monitor.
	 */
	notice(text: string, options?: { readonly final?: boolean }): void
	/** The server closed a WebSocket connection with this code and reason. */
	connectionClosed(code: number, reason: string): void
}

/** A job's process, when something other than the registry starts it. */
export interface JobProcess {
	readonly child: ReturnType<typeof spawn>
	/** How to stop it, when the registry's process-group kill would not reach everything. */
	kill?(signal: NodeJS.Signals): void
	/** Confirm the owned tree stopped; reject instead of claiming an unconfirmed exit. */
	terminate?(signal?: NodeJS.Signals): Promise<void>
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
	readonly spawn?: (host: JobHost) => JobProcess | JobSource
	/**
	 * Output the process already wrote before the registry took it over, in
	 * the order it was written. Used when a foreground command is moved to the
	 * background, so a later `read` starts with what the model was shown.
	 */
	readonly initialOutput?: readonly {
		readonly stream: 'stdout' | 'stderr'
		readonly text: string
	}[]
	/**
	 * `spawn` returned a process on THIS host that the host shell started (a
	 * foreground command being moved to the background), so its bytes are
	 * decoded the way a foreground command's are, not as a Linux guest's.
	 */
	readonly hostOutput?: boolean
	/**
	 * Run the command as a monitor: stdout is split into lines and delivered
	 * to `onMonitorEvent` listeners in batches, and the job is stopped at
	 * `timeoutMs`. Both streams stay in the retained buffer, so `read` still
	 * shows everything, stderr included.
	 */
	readonly monitor?: {
		readonly description: string
		readonly timeoutMs: number
		/** The source is a WebSocket connection and not a command; see {@link BackgroundJob.transport}. */
		readonly transport?: 'websocket'
	}
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
	child: JobChild
	/** The spawner's own kill, when it gave one. */
	killProcess?: (signal: NodeJS.Signals) => void
	terminateProcess?: (signal?: NodeJS.Signals) => Promise<void>
	terminationAttempt?: Promise<void>
	killRequested?: boolean
	closedResult?: { code: number | null; signal: NodeJS.Signals | null }
	finalize?: (code: number | null, signal: NodeJS.Signals | null) => void
	/** Retained tail. */
	buffer: string
	/** Bytes produced in total, including the ones the cap dropped. */
	produced: number
	/** Channel identity is retained separately, under the same byte cap and a chunk cap. */
	outputChunks: OutputChunk[]
	outputObservers: Set<(chunk?: OutputChunk) => void>
	exit: Promise<void>
	/** Settles once the process exists or failed to; `error` says which. */
	started: Promise<{ readonly error?: string }>
	/** Present for a monitor. */
	monitor?: MonitorState
}

interface MonitorState {
	readonly stream: ReturnType<typeof createMonitorStream>
	readonly description: string
	readonly timeoutMs: number
	seq: number
	expiryTimer?: ReturnType<typeof setTimeout>
	/** A terminal notice went out: nothing more is delivered, from the source or from anywhere. */
	sealed?: boolean
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
	private readonly exitListeners = new Set<(job: BackgroundJob) => void>()
	private readonly monitorListeners = new Set<(event: MonitorEvent) => void>()
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

	/**
	 * Be told what a monitor has to say, whoever owns it: a batch of its
	 * stdout lines, or a notice from the monitor itself. Returns the
	 * unsubscribe.
	 *
	 * Every listener hears every monitor's events, whatever their `owner`: a
	 * consumer serving one turn or session MUST filter on `event.owner`, as the
	 * turn does. A listener that throws is its owner's problem, as in
	 * {@link onExit}.
	 */
	onMonitorEvent(listener: (event: MonitorEvent) => void): () => void {
		this.monitorListeners.add(listener)
		return () => {
			this.monitorListeners.delete(listener)
		}
	}

	private announceMonitorEvent(entry: JobEntry, kind: MonitorEvent['kind'], text: string): void {
		const monitor = entry.monitor
		if (!monitor) return
		monitor.seq += 1
		const event: MonitorEvent = {
			id: `${entry.record.id}:${monitor.seq}`,
			jobId: entry.record.id,
			owner: entry.record.owner,
			description: monitor.description,
			kind,
			text,
			at: Date.now(),
			...(entry.record.transport ? { transport: entry.record.transport } : {}),
		}
		for (const listener of this.monitorListeners) {
			try {
				listener(event)
			} catch {
				// A listener that throws is its owner's problem, not the job's.
			}
		}
	}

	/** What a monitor's stream has done so far, for the summary of how it ended. */
	monitorStats(id: string): MonitorStreamStats {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		return entry.monitor?.stream.stats() ?? { eventsDelivered: 0, suppressed: 0, stdoutChars: 0 }
	}

	/** A failed remote stop never releases ownership or announces a terminal job. */
	private confirmTermination(entry: JobEntry): Promise<void> {
		if (entry.terminationAttempt) return entry.terminationAttempt
		const terminate = entry.terminateProcess
		if (!terminate) return Promise.reject(new Error('The process has no confirmed termination API'))
		const attempt = Promise.resolve()
			.then(() => terminate('SIGTERM'))
			.then(() => {
				const { recoveryRequired: _recovery, stopError: _error, ...record } = entry.record
				entry.record = record
				if (entry.closedResult) entry.finalize?.(entry.closedResult.code, entry.closedResult.signal)
			})
			.catch((error: unknown) => {
				entry.record = {
					...entry.record,
					recoveryRequired: true,
					stopError:
						'The process provider could not confirm the owned job stopped; retry termination or recover its environment.',
				}
				for (const observer of entry.outputObservers) observer()
				throw error
			})
			.finally(() => {
				entry.terminationAttempt = undefined
			})
		entry.terminationAttempt = attempt
		return attempt
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

		const id = createBackgroundJobId((candidate) => this.jobs.has(candidate))
		// Same scrub as the foreground path: inheritance is implicit, so the
		// operator's provider credentials do not travel into a command nobody
		// decided should see them. A background job outlives the call that
		// started it, which makes the leak longer-lived, not smaller.
		const inherited = scrubInheritedEnv()

		// The same spawn as a foreground `bash` call, so the permission
		// rules' reading of the line holds for the job too, and so the two
		// cannot disagree about how a shell is started on a given platform.
		const host: JobHost = {
			notice: (text, options) => this.noticeFromSource(entry, text, options?.final === true),
			connectionClosed: (code, reason) => {
				entry.record = { ...entry.record, closeCode: code, closeReason: reason }
			},
		}
		const started: JobProcess | JobSource = params.spawn
			? params.spawn(host)
			: {
					child: spawnHostShell(params.command, {
						cwd: params.workingDirectory,
						env: { ...inherited.env, ...params.env },
						// `detached` makes the child the leader of its own process group
						// off Windows, which is what `killTree` needs to reach the command
						// and everything it forks rather than only the wrapping shell. See
						// `process/kill-tree.ts`.
						stdio: ['ignore', 'pipe', 'pipe'],
					}),
				}
		const child = started.child
		// Started, not adopted: this process stays the parent for the job's
		// whole life. `unref` would let Node exit with the job still running,
		// which is the orphan this registry exists to prevent.
		// Raw bytes, decoded here: a Windows console writes its OEM code page.
		// A process a sandbox started runs a Linux guest, so it is UTF-8.
		const decoders = {
			stdout: createHostOutputDecoder(
				params.spawn && !params.hostOutput ? { platform: 'linux' } : {},
			),
			stderr: createHostOutputDecoder(
				params.spawn && !params.hostOutput ? { platform: 'linux' } : {},
			),
		}
		let startError: string | undefined
		let settleStarted!: () => void
		const startedPromise = new Promise<{ readonly error?: string }>((resolve) => {
			settleStarted = () => resolve(startError === undefined ? {} : { error: startError })
		})
		// A process the host's own spawner started is the host's to vouch for:
		// it may be remote, and need not emit `spawn` at all.
		if (params.spawn || child.pid !== undefined) settleStarted()

		// A monitor's stdout goes through a stream that batches and rations it;
		// everything it says reaches listeners as `MonitorEvent`s. The callbacks
		// close over `entry`, which exists by the time any of them can run.
		const monitor: MonitorState | undefined = params.monitor
			? {
					description: params.monitor.description,
					timeoutMs: params.monitor.timeoutMs,
					seq: 0,
					stream: createMonitorStream({
						onBatch: (text) => this.announceMonitorEvent(entry, 'output', text),
						onNotice: (text) => this.announceMonitorEvent(entry, 'notice', text),
						onOverflow: ({ suppressed, overMs }) => {
							// The reason is recorded before the kill, so the exit that
							// follows is described as what it was and not as a stop
							// somebody asked for.
							entry.record = { ...entry.record, stopReason: 'too_much_output' }
							if (entry.monitor) entry.monitor.sealed = true
							this.announceMonitorEvent(entry, 'notice', tooMuchOutputNotice(suppressed, overMs))
							void this.kill(id).catch(() => {
								// The retained record carries the failure (recoveryRequired).
							})
						},
					}),
				}
			: undefined
		const startedAt = Date.now()

		let finalizeEntry!: (code: number | null, signal: NodeJS.Signals | null) => void
		const entry: JobEntry = {
			record: {
				id,
				owner: params.owner,
				command: params.command,
				status: 'running',
				startedAt,
				...(monitor
					? {
							kind: 'monitor' as const,
							description: monitor.description,
							expiresAt: startedAt + monitor.timeoutMs,
							...(params.monitor?.transport ? { transport: params.monitor.transport } : {}),
						}
					: {}),
			},
			...(monitor ? { monitor } : {}),
			child,
			...(started.kill ? { killProcess: started.kill.bind(started) } : {}),
			...(started.terminate ? { terminateProcess: started.terminate.bind(started) } : {}),
			buffer: '',
			produced: 0,
			outputChunks: [],
			outputObservers: new Set(),
			started: startedPromise,
			exit: new Promise<void>((resolve) => {
				let spawned = child.pid !== undefined
				let failedToSpawn = false
				let finalized = false
				const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
					if (finalized) return
					finalized = true
					entry.record = {
						...entry.record,
						// A job killed by this registry says `killed`, not
						// `exited` with a signal a reader has to interpret. The
						// two are different answers to "why did my job stop".
						status: entry.killRequested || entry.record.status === 'killed' ? 'killed' : 'exited',
						exitedAt: Date.now(),
						...(code === null ? {} : { exitCode: code }),
						...(signal ? { signal } : {}),
					}
					resolve()
					for (const observer of entry.outputObservers) observer()
					if (entry.monitor) {
						// The last batch is a monitor's last words and must precede
						// the exit: a listener that learns the job ended and THEN
						// gets output would be telling the model about a finished
						// watch after it had been told the watch was over.
						clearTimeout(entry.monitor.expiryTimer)
						entry.monitor.stream.drain()
						entry.monitor.stream.close()
					}
					this.announceExit(entry.record)
				}
				finalizeEntry = finalize
				child.once('spawn', () => {
					spawned = true
					settleStarted()
				})
				child.on('error', (error) => {
					// A failed spawn emits both `error` and `close`. Waiting for
					// `close` also covers errors on an already-running process
					// (such as a failed kill) without announcing a false exit.
					if (spawned) return
					failedToSpawn = true
					startError ??= describeSpawnFailure(error, params.workingDirectory)
					settleStarted()
				})
				child.once('close', (code, signal) => {
					for (const stream of ['stdout', 'stderr'] as const) {
						const rest = decoders[stream].end()
						if (rest) append(rest, stream)
					}
					if (failedToSpawn && startError !== undefined) {
						// In the output too, so a caller that only reads output (or
						// redirects it, as a model does) still learns why it is empty.
						append(`${startError}\n`, 'stderr')
						entry.record = { ...entry.record, error: startError }
					}
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
					if (entry.terminateProcess) {
						entry.closedResult = { code: exitCode, signal }
						void this.confirmTermination(entry).catch(() => {
							// The retained running record exposes recoveryRequired. A
							// later kill retries instead of forgetting the guest tree.
						})
						return
					}
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
		entry.finalize = finalizeEntry

		const append = (text: string, stream: 'stdout' | 'stderr'): void => {
			const chunk: OutputChunk = { stream, offset: entry.produced, bytes: Buffer.from(text) }
			if (chunk.bytes.length === 0) return
			entry.produced += chunk.bytes.length
			entry.buffer += text
			entry.buffer = outputTail(entry.buffer, this.maxBytes).text
			entry.outputChunks.push(chunk)
			// Only stdout is an event. stderr stays readable with `read`, which is
			// where a watcher's diagnostics belong: a model told about every
			// warning line would stop reading the events that matter.
			if (stream === 'stdout') entry.monitor?.stream.push(text)
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
		const onData = (stream: 'stdout' | 'stderr') => (data: Buffer | string) => {
			const text = typeof data === 'string' ? data : decoders[stream].write(data)
			if (text) append(text, stream)
		}
		for (const seed of params.initialOutput ?? []) append(seed.text, seed.stream)
		child.stdout?.on('data', onData('stdout'))
		child.stderr?.on('data', onData('stderr'))

		this.jobs.set(id, entry)
		if (monitor) {
			// A monitor has a life. Without a deadline a watch the model forgot
			// would run, and bill its events, until the session ended.
			monitor.expiryTimer = setTimeout(() => this.expireMonitor(entry), monitor.timeoutMs)
			monitor.expiryTimer.unref?.()
		}
		return entry.record
	}

	/** The deadline: the last batch, then the notice, then the same kill every stop uses. */
	private expireMonitor(entry: JobEntry): void {
		const monitor = entry.monitor
		if (!monitor || entry.record.status !== 'running') return
		monitor.stream.flush()
		// The flush can itself have stopped the monitor for too much output.
		if (entry.record.stopReason !== undefined || entry.record.status !== 'running') return
		entry.record = { ...entry.record, stopReason: 'expired' }
		this.announceMonitorEvent(
			entry,
			'notice',
			expiryNotice(monitor.timeoutMs, monitor.stream.stats().eventsDelivered),
		)
		// Nothing follows a terminal notice. A command that ignores SIGTERM keeps
		// printing until the SIGKILL, and those lines would reach the model after
		// it was told the watch was over.
		monitor.sealed = true
		monitor.stream.close()
		void this.kill(entry.record.id).catch(() => {
			// The retained record carries the failure (recoveryRequired).
		})
	}

	/**
	 * A notice from the source of a monitor (a WebSocket's upgrade was refused,
	 * its connection closed). Delivered after whatever was already complete, so
	 * the last lines are not overtaken by the news that the stream ended.
	 */
	private noticeFromSource(entry: JobEntry, text: string, final: boolean): void {
		const monitor = entry.monitor
		if (!monitor || monitor.sealed) return
		monitor.stream.flush()
		// The flush can itself have stopped the monitor for too much output.
		if (monitor.sealed) return
		this.announceMonitorEvent(entry, 'notice', text)
		if (final) {
			monitor.sealed = true
			monitor.stream.close()
		}
	}

	/**
	 * Resolves once the job's process exists, or once it could not be
	 * created (`error` then says why). Lets a caller report a start that
	 * failed in the same reply that would otherwise say "started".
	 */
	awaitStarted(id: string): Promise<{ readonly error?: string }> {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		return entry.started
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
			...(entry.record.error === undefined ? {} : { error: entry.record.error }),
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
			...(entry.record.error === undefined ? {} : { error: entry.record.error }),
		}
	}

	/** SIGTERM the tree, then SIGKILL after the shared grace period. */
	async kill(id: string): Promise<BackgroundJob> {
		const entry = this.jobs.get(id)
		if (!entry) throw new UnknownBackgroundJobError({ id })
		if (entry.record.status !== 'running') return entry.record
		// A stop nobody else explained is the model's (or the operator's). The
		// expiry and output rules record their own reason first.
		const stoppedBy = entry.monitor !== undefined && entry.record.stopReason === undefined
		if (stoppedBy) entry.record = { ...entry.record, stopReason: 'stopped' }
		// An accepted stop ends the event stream: what was already complete goes
		// out, and nothing the dying process prints afterwards does. (The expiry
		// and output rules close it themselves, after their own notice.)
		const closeStream = (): void => {
			if (!stoppedBy || !entry.monitor) return
			entry.monitor.stream.flush()
			entry.monitor.sealed = true
			entry.monitor.stream.close()
		}
		if (entry.terminateProcess) {
			entry.killRequested = true
			try {
				await this.confirmTermination(entry)
			} catch (error) {
				// Still running: do not leave it saying a stop happened.
				if (stoppedBy) {
					const { stopReason: _reason, ...rest } = entry.record
					entry.record = rest
				}
				throw error
			}
			// Only once the stop is confirmed: a remote stop that failed leaves a
			// running monitor, and a closed stream could not be reopened.
			closeStream()
			await entry.exit
			return entry.record
		}

		// Marked before the signal, so the `close` handler that follows can
		// tell a kill from an ordinary exit. Set it after and the race decides
		// which of two different answers a reader gets.
		entry.record = { ...entry.record, status: 'killed' }
		closeStream()
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
		/**
		 * The longest a monitor started through this binding may live. A host
		 * may lower it (a single-shot run has no tomorrow to watch for); the
		 * default is {@link MONITOR_TIMEOUT_CAP_MS}.
		 */
		readonly monitorTimeoutCapMs?: number
		/**
		 * Be told that this binding started a monitor. The turn passes its own
		 * recorder here when the monitor belongs to the turn itself, which is
		 * what makes the turn stay open for it; a session-owned monitor is not
		 * reported, because the host wakes on its events.
		 */
		readonly onMonitorStarted?: (id: string) => void
	} = {},
) {
	const mine = (id: string): BackgroundJob => {
		const job = registry.get(id)
		if (job.owner !== owner) throw new UnknownBackgroundJobError({ id })
		return job
	}
	const launch = (
		params: { command: string; workingDirectory?: string },
		monitor?: StartJobParams['monitor'],
	): BackgroundJob => {
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
			...(monitor ? { monitor } : {}),
		})
	}
	const clampMonitorTimeout = (requested: number): number =>
		Math.min(requested, defaults.monitorTimeoutCapMs ?? MONITOR_TIMEOUT_CAP_MS)
	return {
		start: (params: { command: string; workingDirectory?: string }) => launch(params),
		// The same spawn, owner and cap as `start`, plus a deadline. The timeout
		// is clamped to the host's ceiling and the clamped value is returned, so
		// the number the model is told is the number that will fire.
		startMonitor: (params: {
			command: string
			description: string
			timeoutMs: number
			workingDirectory?: string
		}) => {
			const timeoutMs = clampMonitorTimeout(params.timeoutMs)
			const job = launch(params, { description: params.description, timeoutMs })
			defaults.onMonitorStarted?.(job.id)
			return { job, timeoutMs }
		},
		// A monitor whose source is a WebSocket connection the HOST process
		// opens, whatever the sandbox spawn would have done with a command: the
		// tool has already checked the address and the sandbox's network rule,
		// and the socket is pinned to the addresses it checked. A separate
		// method so a host that implements `startMonitor` for commands is not
		// handed an input it never wrote code for.
		startWebSocketMonitor: (params: {
			description: string
			timeoutMs: number
			workingDirectory?: string
			webSocket: MonitorWebSocketTarget
		}) => {
			const timeoutMs = clampMonitorTimeout(params.timeoutMs)
			const { webSocket } = params
			const job = registry.start({
				owner,
				command: webSocketJobCommand(webSocket.url),
				workingDirectory: params.workingDirectory ?? defaults.workingDirectory ?? process.cwd(),
				spawn: (host) => connectWebSocketSource({ target: webSocket, host }),
				monitor: { description: params.description, timeoutMs, transport: 'websocket' },
			})
			defaults.onMonitorStarted?.(job.id)
			return { job, timeoutMs }
		},
		// A foreground command that ran out of time, kept instead of killed.
		// The same owner and cap as `start`; the process is the one already
		// running, with what it has written so far.
		adopt: (params: {
			command: string
			child: ReturnType<typeof spawn>
			workingDirectory?: string
			initialOutput?: StartJobParams['initialOutput']
		}) =>
			registry.start({
				owner,
				command: params.command,
				workingDirectory: params.workingDirectory ?? defaults.workingDirectory ?? process.cwd(),
				spawn: () => ({ child: params.child }),
				hostOutput: true,
				...(params.initialOutput ? { initialOutput: params.initialOutput } : {}),
			}),
		get: (id: string) => mine(id),
		awaitStarted: (id: string) => {
			mine(id)
			return registry.awaitStarted(id)
		},
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

/**
 * How a monitor ended, in the words the model, the transcript and a
 * single-shot run all use, so the three cannot disagree about it.
 *
 * `completed` is the command ending by itself: with output it is the stream
 * ending, and without any it is a watch that never saw anything, which a
 * reader must not mistake for a quiet success. A non-zero exit is `failed`.
 * `killed` covers every stop the registry or the model asked for; the expiry
 * and the too-much-output stop already told the model why in a notice of their
 * own, so the summary does not repeat it.
 */
export function describeMonitorEnd(
	job: Pick<
		BackgroundJob,
		| 'description'
		| 'status'
		| 'exitCode'
		| 'signal'
		| 'error'
		| 'transport'
		| 'closeCode'
		| 'closeReason'
	>,
	stats: Pick<MonitorStreamStats, 'stdoutChars'>,
): { status: 'completed' | 'failed' | 'killed'; summary: string } {
	const label = `Monitor "${oneMetadataLine(job.description ?? 'unnamed')}"`
	if (job.status === 'killed') return { status: 'killed', summary: `${label} stopped` }
	if (job.transport === 'websocket') {
		// A connection has no script to fail and no exit status to quote: it was
		// closed, by the server and with a code, or it never opened.
		if (job.closeCode === undefined)
			return { status: 'failed', summary: `${label} connection failed` }
		// The code only. The server's reason is text it chose, and the summary
		// is a metadata line outside the untrusted frame; the reason reaches the
		// model inside the frame, in the `[WebSocket closed: ...]` notice.
		return {
			status: job.exitCode === 0 ? 'completed' : 'failed',
			summary: `${label} connection closed (${job.closeCode})`,
		}
	}
	if (job.exitCode === 0 && job.error === undefined) {
		return stats.stdoutChars > 0
			? { status: 'completed', summary: `${label} stream ended` }
			: { status: 'completed', summary: `${label} ended without producing output (exit 0)` }
	}
	const how = job.exitCode !== undefined ? `exit ${job.exitCode}` : (job.signal ?? 'exit unknown')
	return { status: 'failed', summary: `${label} script failed (${how})` }
}
