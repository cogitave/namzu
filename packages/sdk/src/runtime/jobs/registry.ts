import { spawn } from 'node:child_process'

import { SANDBOX_KILL_GRACE_MS } from '../../constants/sandbox/index.js'
import { killTree } from '../../process/kill-tree.js'
import { scrubInheritedEnv } from '../../tools/env-scrub.js'

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
	/** Whoever the job dies with — a run id, in practice. */
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

export interface StartJobParams {
	readonly owner: string
	readonly command: string
	readonly workingDirectory: string
	readonly env?: Readonly<Record<string, string>>
}

export interface BackgroundJobRegistryConfig {
	/**
	 * Refused past this many LIVE jobs for one owner.
	 *
	 * Per owner rather than global: one run spawning a hundred watchers must
	 * not be able to refuse a different run its first.
	 */
	readonly maxJobsPerOwner?: number
	/** Retained output per job. Oldest bytes go first, and are counted. */
	readonly maxOutputBytesPerJob?: number
}

const DEFAULT_MAX_JOBS_PER_OWNER = 8
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

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
	/** Retained tail. */
	buffer: string
	/** Bytes produced in total, including the ones the cap dropped. */
	produced: number
	exit: Promise<void>
}

export class BackgroundJobRegistry {
	private readonly jobs = new Map<string, JobEntry>()
	private counter = 0

	constructor(private readonly config: BackgroundJobRegistryConfig = {}) {}

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
			// work minutes later against a run that has since ended — the model
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

		const child = spawn('/bin/sh', ['-c', params.command], {
			cwd: params.workingDirectory,
			env: { ...inherited.env, ...params.env },
			// Leader of its own process group, which is what `killTree` needs
			// to reach the command and everything it forks rather than only the
			// wrapping shell. See `process/kill-tree.ts`.
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
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
			buffer: '',
			produced: 0,
			exit: new Promise<void>((resolve) => {
				child.once('close', (code, signal) => {
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
				})
				child.once('error', () => {
					entry.record = { ...entry.record, status: 'exited', exitedAt: Date.now() }
					resolve()
				})
			}),
		}

		const append = (text: string): void => {
			entry.produced += Buffer.byteLength(text)
			entry.buffer += text
			const over = Buffer.byteLength(entry.buffer) - this.maxBytes
			if (over > 0) {
				// Oldest first. A cap that dropped the NEWEST bytes would hide
				// exactly the part a poller is waiting for.
				//
				// Nothing accumulates a drop counter here, deliberately. What a
				// reader needs is how much IT missed, which depends on where its
				// own offset was — a running total of everything ever dropped
				// answers a different question, and `read` derives the right one
				// from `produced` and the retained length.
				entry.buffer = Buffer.from(entry.buffer).subarray(over).toString('utf8')
			}
		}
		child.stdout?.on('data', (text: string) => append(text))
		child.stderr?.on('data', (text: string) => append(text))

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
		const chunk = Buffer.from(entry.buffer).subarray(skip).toString('utf8')

		return {
			chunk,
			nextOffset: entry.produced,
			droppedBytes: Math.max(0, effective - from),
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
		killTree(entry.child, 'SIGTERM')
		const grace = setTimeout(() => killTree(entry.child, 'SIGKILL'), SANDBOX_KILL_GRACE_MS)
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
	 * The teardown call. Without it a run that ends leaves its jobs running
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
 * else's run, nor read or kill one. `list` and the lookups are filtered to
 * the same owner, so an id from another run reads as unknown — the same
 * answer the tenant checks give elsewhere in this tree, and for the same
 * reason.
 */
export function bindOwner(
	registry: BackgroundJobRegistry,
	owner: string,
	defaults: { readonly workingDirectory?: string; readonly env?: Record<string, string> } = {},
) {
	const mine = (id: string): BackgroundJob => {
		const job = registry.get(id)
		if (job.owner !== owner) throw new UnknownBackgroundJobError({ id })
		return job
	}
	return {
		start: (params: { command: string; workingDirectory?: string }) =>
			registry.start({
				owner,
				command: params.command,
				workingDirectory: params.workingDirectory ?? defaults.workingDirectory ?? process.cwd(),
				...(defaults.env ? { env: defaults.env } : {}),
			}),
		get: (id: string) => mine(id),
		read: (id: string, opts?: { fromOffset?: number }) => {
			mine(id)
			return registry.read(id, opts ?? {})
		},
		kill: async (id: string) => {
			mine(id)
			return await registry.kill(id)
		},
		list: () => registry.list(owner),
	}
}
