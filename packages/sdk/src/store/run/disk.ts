import { randomUUID } from 'node:crypto'
import {
	appendFile,
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { CheckpointId, DecisionClaim, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { PersistedRunMeta, Run, RunEvent, RunStoreConfig } from '../../types/run/index.js'
import {
	DEFAULT_RUN_LEASE_TTL_MS,
	type RunLease,
	RunLeaseHeldError,
	RunLeaseLostError,
	type RunLeaseOptions,
	RunLeaseUnreadableError,
	type RunLeaseView,
	RunWriteLockTimeoutError,
} from '../../types/run/lease.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

/**
 * How long a caller waits for a run's write lock before giving up and refusing to write.
 *
 * A commit under the lock is a temp write plus a rename. Waiting longer than this means
 * the holder is not committing, it is wedged.
 */
const WRITE_LOCK_WAIT_MS = 5_000

/**
 * When a write lock is old enough to be presumed orphaned, and broken.
 *
 * A lock is held across two syscalls. A lock file older than this belongs to a process
 * that died holding it, and leaving it in place would brick every writer on the run
 * forever — trading the bug this lock exists to fix for a worse one. The gap between a
 * real commit (microseconds) and this bound (seconds) is four orders of magnitude, which
 * is what makes breaking it safe.
 */
const WRITE_LOCK_STALE_MS = 10_000

export class RunDiskStore {
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private indexLock: Promise<void> = Promise.resolve()
	private commitChain: Promise<void> = Promise.resolve()
	private inCommit = false
	private checkpointLocks = new Map<CheckpointId, Promise<void>>()
	/**
	 * The lease this store writes under, when it writes on a segment's behalf.
	 *
	 * `null` is not "unfenced by accident" — it is the **control plane**: a cancel, a
	 * token redemption, an operator read. Those must work *while a segment holds the
	 * lease* (a cancel that could not touch a running run would be useless), and their own
	 * races are arbitrated by the decision claim, which is a compare-and-set on the
	 * durable record. The lease governs the execution plane: whoever is driving the loop.
	 */
	private lease: RunLease | null = null
	/**
	 * The lease this store GAVE UP, when it gave it up while its segment was still alive.
	 *
	 * The difference between this and `lease: null` is the whole reason it exists. A store
	 * that never had a lease is the control plane and writes freely. A store that HAD one
	 * and handed it back mid-segment — because its consumer abandoned it
	 * ({@link disownLease}) — must not fall back to the control plane's privileges: it
	 * would become an unfenced writer on a run it no longer owns, which is strictly worse
	 * than the fenced writer it was. Every write from here is refused.
	 */
	private disowned: RunLease | null = null

	constructor(config: RunStoreConfig) {
		this.baseDir = config.baseDir
		this.log = (config.logger ?? getRootLogger()).child({ component: 'RunDiskStore' })
	}

	private requireInit(): string {
		if (!this.runDir) {
			throw new Error('RunDiskStore not initialized — call initRun() first')
		}
		return this.runDir
	}

	async initRun(runId: string, parentRunId?: string): Promise<string> {
		if (parentRunId) {
			this.runDir = join(this.baseDir, parentRunId, 'children', runId)
		} else {
			this.runDir = join(this.baseDir, runId)
		}
		await mkdir(this.runDir, { recursive: true })
		this.log.info(`Run directory created: ${this.runDir}`)
		return this.runDir
	}

	// ─── The run lease (ses_017 G1) ──────────────────────────────────────────
	//
	// One run, one driver. The lease is a *sequence* of exclusive-create files —
	// `leases/000001.json`, `leases/000002.json`, … — and the file's number IS the fencing
	// token. That construction gives three things at once, which is why it is this and not
	// a single mutable `lease.json`:
	//
	//   1. **Arbitration.** Taking the lease means creating the next token with `wx`. Two
	//      processes racing to take over one stale lease both try to create the same file;
	//      the filesystem picks one. Same primitive as `claimDecision`, deliberately.
	//   2. **Monotonicity for free.** The token cannot go backwards, because a lower one
	//      already exists on disk. No counter to persist, no read-modify-write to race.
	//   3. **An audit trail.** Every takeover leaves its record. "Who has been driving this
	//      run, and when did they stop renewing" is answerable after the fact.
	//
	// Renewal rewrites the holder's OWN file (nobody else writes it, so there is no lock).
	// Release stamps `releasedAt` on it, which frees the run immediately — that is what
	// makes a parked run resumable the instant it parks, rather than one TTL later.

	private leasesDir(): string {
		return join(this.requireInit(), 'leases')
	}

	/** Who owns this run, right now — the operator-facing read. */
	async readLease(): Promise<RunLeaseView> {
		const current = await this.readCurrentLease()
		if (!current) return { status: 'free', token: 0 }

		if (current.releasedAt !== undefined) {
			return { status: 'free', token: current.token, lease: current }
		}

		const expiresAt = current.renewedAt + current.ttlMs
		return {
			status: Date.now() <= expiresAt ? 'held' : 'stale',
			token: current.token,
			lease: current,
			expiresAt,
		}
	}

	/**
	 * Take the run's lease, or refuse.
	 *
	 * Refuses with {@link RunLeaseHeldError} when a live segment holds it. Takes it over —
	 * at a HIGHER token, which fences the old holder's writes — when the lease is stale or
	 * was released. The takeover does not require the old holder to be dead, only to be
	 * stale; being wrong about that is survivable precisely because of the fence.
	 */
	async acquireLease(runId: RunId, options: RunLeaseOptions = {}): Promise<RunLease> {
		const dir = this.leasesDir()
		await mkdir(dir, { recursive: true })

		const ttlMs = options.ttlMs ?? DEFAULT_RUN_LEASE_TTL_MS
		const holderId = options.holderId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

		// The takeover runs under the run's WRITE LOCK, for the same reason a fenced write
		// does: minting token N+1 is what invalidates the incumbent, and if it can land
		// between an incumbent's fence check and that write's commit, the fence check was a
		// lie. Taking the lock here and there is what makes [check the token → commit] and
		// [take the run over] indivisible with respect to each other. See {@link commit}.
		return this.withWriteLock(`acquire the lease for run ${runId}`, runId, async () => {
			// Bounded retry: each failed exclusive create means somebody else took the token we
			// wanted, so the next read shows THEM as the holder and we refuse. The loop exists
			// for the one case where that is not true — a taker that crashed between creating
			// its file and nothing else, leaving a token nobody is renewing — where the next
			// attempt simply takes the token above it.
			for (let attempt = 0; attempt < 5; attempt++) {
				const view = await this.readLease()
				if (view.status === 'held' && view.lease) {
					throw new RunLeaseHeldError(view.lease)
				}

				const now = Date.now()
				const lease: RunLease = {
					runId,
					token: view.token + 1,
					holderId,
					acquiredAt: now,
					renewedAt: now,
					ttlMs,
				}

				try {
					await atomicCreateFile(this.leasePath(lease.token), JSON.stringify(lease, null, 2))
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
					continue
				}

				if (view.status === 'stale' && view.lease) {
					this.log.warn(
						'Took over a run whose lease went stale — the previous segment stopped renewing and is presumed dead. Its writes are now fenced off.',
						{
							runId,
							previousHolder: view.lease.holderId,
							previousToken: view.lease.token,
							notRenewedSince: new Date(view.lease.renewedAt).toISOString(),
							token: lease.token,
						},
					)
				}

				this.lease = lease
				this.disowned = null
				return lease
			}

			// Five consecutive losses of the create race with nobody holding the result. This
			// is not a state the filesystem should be able to produce; refusing is the only
			// honest answer, because the alternative is to write under a token we did not win.
			throw new Error(
				`Could not acquire the lease for run ${runId}: the fencing token kept being taken from under us. Retry.`,
			)
		})
	}

	/**
	 * Heartbeat. Refuses with {@link RunLeaseLostError} if the run has been taken over —
	 * which is how a stalled segment finds out it no longer owns the run it thinks it is
	 * driving, and can stop before it does any more work.
	 *
	 * **A renewal after the lease was handed back is refused, not applied.** The check is
	 * re-made under the write lock, not only on the way in: `release()` and an in-flight
	 * heartbeat are two coroutines racing for one file, and a renewal that lands after the
	 * release rewrites `leases/000002.json` WITHOUT `releasedAt` — resurrecting, for a full
	 * TTL, a lease no live segment holds. Every resume of that run is then refused
	 * `RunLeaseHeldError` on behalf of a process that has already exited, which is the exact
	 * inverse of the "a parked run is resumable AT ONCE" guarantee release exists to give.
	 */
	async renewLease(): Promise<RunLease> {
		if (!this.lease) {
			throw new Error('renewLease() called without a lease — acquireLease() first')
		}

		return this.commit('renew the lease', async () => {
			const held = this.lease
			if (!held) {
				throw new Error('renewLease() raced a release — the lease was handed back')
			}
			const renewed: RunLease = { ...held, renewedAt: Date.now() }
			await atomicWriteJson(this.leasePath(held.token), renewed)
			this.lease = renewed
			return renewed
		})
	}

	/**
	 * Hand the lease back. The run is free immediately.
	 *
	 * A segment that has been FENCED releases nothing: the lease it holds is not the run's
	 * current lease, and stamping `releasedAt` on a superseded record would be writing
	 * about a run that is not ours — the exact class of write the fence exists to refuse.
	 * It drops its own handle and says so.
	 */
	async releaseLease(): Promise<void> {
		const held = this.lease
		if (!held) return
		this.lease = null

		await this.withWriteLock(`release the lease for run ${held.runId}`, held.runId, async () => {
			const current = await this.readCurrentLease()
			if (!current || current.token !== held.token) {
				this.log.warn(
					'Not releasing a lease this segment no longer holds — the run was taken over',
					{
						runId: held.runId,
						heldToken: held.token,
						currentToken: current?.token ?? 0,
					},
				)
				return
			}

			await atomicWriteJson(this.leasePath(held.token), { ...held, releasedAt: Date.now() })
		})
	}

	/**
	 * Give the run back AND refuse every write from here on.
	 *
	 * For the one exit that is neither a park, a finish nor a failure: a segment whose
	 * consumer walked away ({@link import('../../types/run/lease.js').RunSegmentAbandonedError}).
	 * A plain {@link releaseLease} would be worse than doing nothing — it clears `lease`,
	 * and a store with no lease is the CONTROL PLANE, which is deliberately unfenced. So a
	 * consumer that came back and pulled one more event would find its segment writing
	 * freely to a run it had just handed to somebody else. The lease goes back; the right
	 * to write does not come with it.
	 */
	async disownLease(): Promise<void> {
		const held = this.lease
		if (!held) return
		await this.releaseLease()
		this.disowned = held
	}

	/** The lease this store writes under, if any. */
	getLease(): RunLease | null {
		return this.lease
	}

	private leasePath(token: number): string {
		return join(this.leasesDir(), `${String(token).padStart(6, '0')}.json`)
	}

	/**
	 * The run's current lease, or `null` if it has never been leased.
	 *
	 * **A lease that exists and cannot be read is not `null`.** It raises
	 * {@link RunLeaseUnreadableError}, because the alternative — swallowing the parse error
	 * and reporting the run free — hands the run to a second driver on the strength of a
	 * file we failed to read. The one thing this must never do is turn "I don't know" into
	 * "nobody owns it".
	 *
	 * It retries once before giving up. The create is atomic (see {@link atomicCreateFile}),
	 * so a torn lease should not be producible any more; the retry is what makes that a
	 * belief the code does not depend on.
	 */
	private async readCurrentLease(): Promise<RunLease | null> {
		let files: string[]
		try {
			files = await readdir(this.leasesDir())
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}

		let highest = 0
		for (const file of files) {
			if (!file.endsWith('.json')) continue
			const token = Number.parseInt(file.slice(0, -'.json'.length), 10)
			if (Number.isFinite(token) && token > highest) highest = token
		}
		if (highest === 0) return null

		let lastError: unknown
		for (let attempt = 0; attempt < 2; attempt++) {
			let raw: string
			try {
				raw = await readFile(this.leasePath(highest), 'utf-8')
			} catch (err) {
				// Gone between the readdir and the read. Nothing creates a lease and then
				// deletes it, so this is a directory that was cleaned up under us: no lease.
				if (isFileNotFound(err)) return null
				throw err
			}

			try {
				const lease = JSON.parse(raw) as RunLease
				if (typeof lease?.token !== 'number' || typeof lease?.renewedAt !== 'number') {
					throw new Error('not a lease record')
				}
				return lease
			} catch (err) {
				lastError = err
			}
			await sleep(5)
		}

		throw new RunLeaseUnreadableError(this.requireInit(), highest, lastError)
	}

	/**
	 * **The fence.** Every write a SEGMENT makes passes through here first.
	 *
	 * The check is a fact on disk, not a fact in memory: a stalled process believes it
	 * holds the lease right up to the moment it is told otherwise, so asking it is
	 * worthless. It re-reads the current token and refuses if it is not the one it holds.
	 *
	 * **It is only a fence because of the lock around it** ({@link commit}). On its own it
	 * is check-then-act: the token is read in one `await` and the write commits in a later
	 * one, and a takeover landing in that gap makes the check a lie — the superseded segment
	 * passes it, is descheduled, and lands its write on the run somebody else now owns.
	 * Worse, `persist()` chains four such writes, so a takeover mid-chain leaves `run.json`
	 * written by one segment and `messages.json` by another: a record whose history does not
	 * match its own `messageCount`, which is what the next resume reads. The lock is what
	 * makes [check the token → commit the writes] one indivisible act.
	 *
	 * A store with no lease is the control plane (cancel, redemption, operator reads) and
	 * is deliberately not fenced — see {@link lease}. A store that GAVE ITS LEASE BACK is
	 * not the control plane and is refused outright — see {@link disowned}.
	 *
	 * `transcript.jsonl` is deliberately NOT fenced: it is append-only, so a superseded
	 * segment's events cannot destroy the new segment's, and refusing them would throw
	 * away the evidence of what the stalled process was doing. Everything that REPLACES a
	 * file — the run meta, the messages, the checkpoints, the index — is fenced.
	 */
	private async assertFence(operation: string): Promise<void> {
		const abandoned = this.disowned
		if (abandoned) {
			const current = await this.readCurrentLease()
			throw new RunLeaseLostError(
				abandoned.runId,
				abandoned.token,
				current?.token ?? 0,
				`${operation} (this segment gave the run back)`,
			)
		}

		const held = this.lease
		if (!held) return

		const current = await this.readCurrentLease()
		const currentToken = current?.token ?? 0
		if (currentToken !== held.token) {
			throw new RunLeaseLostError(held.runId, held.token, currentToken, operation)
		}
	}

	/**
	 * Run a group of writes as ONE fenced commit: the token is checked, and no takeover can
	 * land until every write in the group has hit the disk.
	 *
	 * This is the fence's missing half. `assertFence` alone establishes that the token was
	 * ours *a moment ago*; the write lock establishes that it still is at the instant the
	 * rename commits, and that it stays ours for the whole group. `RunPersistence.persist()`
	 * wraps its four writes in one of these, which is why a takeover cannot split a run's
	 * record between two segments.
	 *
	 * Re-entrant per store instance: a nested call is already inside its parent's lock and
	 * inside its parent's fence check, and re-taking either would deadlock on ourselves.
	 * Concurrent calls on the SAME instance are serialised in-process first, so `inCommit`
	 * can never be observed by a commit that does not own it.
	 */
	async commit<T>(operation: string, write: () => Promise<T>): Promise<T> {
		if (this.inCommit) return write()

		const previous = this.commitChain
		let done!: () => void
		this.commitChain = new Promise<void>((resolve) => {
			done = resolve
		})

		try {
			await previous
			const runId = (this.lease ?? this.disowned)?.runId ?? ('unleased' as RunId)
			return await this.withWriteLock(operation, runId, async () => {
				this.inCommit = true
				try {
					await this.assertFence(operation)
					return await write()
				} finally {
					this.inCommit = false
				}
			})
		} finally {
			done()
		}
	}

	private writeLockPath(): string {
		return join(this.requireInit(), '.write.lock')
	}

	/**
	 * The run's cross-process write lock: an exclusive create, the same primitive the lease
	 * and the decision claim are arbitrated by, held for exactly one commit.
	 *
	 * A lock nobody can break is a lock that turns one crash into a permanently unwritable
	 * run, so this one can be broken — but only after {@link WRITE_LOCK_STALE_MS}, which is
	 * four orders of magnitude longer than the two syscalls it is held across. That gap is
	 * what makes breaking it safe: a lock that old is not a commit in progress.
	 */
	private async withWriteLock<T>(
		operation: string,
		runId: RunId,
		fn: () => Promise<T>,
	): Promise<T> {
		const lockPath = this.writeLockPath()
		const deadline = Date.now() + WRITE_LOCK_WAIT_MS

		while (true) {
			try {
				await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
					encoding: 'utf-8',
					flag: 'wx',
				})
				break
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

				const heldFor = await lockAgeMs(lockPath)
				if (heldFor !== null && heldFor > WRITE_LOCK_STALE_MS) {
					this.log.warn(
						'Breaking a run write lock nobody released — the process holding it died mid-commit',
						{ runId, operation, heldForMs: heldFor },
					)
					await unlink(lockPath).catch(() => undefined)
					continue
				}

				if (Date.now() >= deadline) {
					throw new RunWriteLockTimeoutError(runId, operation, WRITE_LOCK_WAIT_MS)
				}
				await sleep(2 + Math.floor(Math.random() * 8))
			}
		}

		try {
			return await fn()
		} finally {
			await unlink(lockPath).catch(() => undefined)
		}
	}

	async appendEvent(event: RunEvent): Promise<void> {
		const dir = this.requireInit()

		const line = `${JSON.stringify({
			...event,
			timestamp: Date.now(),
		})}\n`

		await appendFile(join(dir, 'transcript.jsonl'), line, 'utf-8')
	}

	async writeRunMeta(run: Run): Promise<void> {
		const dir = this.requireInit()

		const meta: Record<string, unknown> = {
			id: run.id,
			status: run.status,
			metadata: run.metadata,
			tokenUsage: run.tokenUsage,
			currentIteration: run.currentIteration,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			lastError: run.lastError,
			messageCount: run.messages.length,
		}

		if (run.parentRunId) meta.parentRunId = run.parentRunId
		if (run.depth !== undefined && run.depth > 0) meta.depth = run.depth
		// A fork's provenance. It is on the RUN's own record, not only in the caller's
		// head, because "where did this run come from" is the first question asked of a run
		// that exists because somebody re-drove a checkpoint — and the source run's record
		// says nothing about it (a fork must not touch its source; that is what makes it a
		// fork rather than an overwrite).
		if (run.replayOf) meta.replayOf = run.replayOf
		// The pointer to the decision the run is parked on. A POINTER: the decision itself
		// lives on the checkpoint, and copying it here would create a second source of
		// truth that the first crash leaves disagreeing with the first. It is here because
		// `run.json` is the only file a cancel — or a fresh process — can find without
		// already knowing which checkpoint to look at.
		if (run.awaitingDecision) meta.awaitingDecision = run.awaitingDecision

		await this.commit('write run.json', () => atomicWriteJson(join(dir, 'run.json'), meta))
	}

	/**
	 * Read-modify-write the run's meta file.
	 *
	 * The narrow write a durable cancel needs: it holds a `PersistedRunMeta` (what is on
	 * disk), not a `Run` (what a live process has), and {@link writeRunMeta} takes the
	 * latter. Reconstructing a `Run` to get at one field would mean inventing the fields
	 * the meta file does not carry — `messages` above all — and the first one invented
	 * as `[]` silently rewrites `messageCount` to zero.
	 *
	 * `mutate` returning `undefined` means "no change" and skips the write.
	 */
	async updateRunMeta(
		mutate: (meta: PersistedRunMeta) => PersistedRunMeta | undefined,
	): Promise<PersistedRunMeta | null> {
		const dir = this.requireInit()
		return this.commit('update run.json', async () => {
			const current = await this.readRunMeta()
			if (!current) return null

			const next = mutate(current)
			if (!next) return current

			await atomicWriteJson(join(dir, 'run.json'), next)
			return next
		})
	}

	/**
	 * Read back the run's own meta file.
	 *
	 * The durable-resume path needs it: a decision may only be answered while the run
	 * is actually parked, and "is this run still resumable?" is a question about the
	 * run's persisted status, not about the checkpoint. Reading it here is what lets
	 * `resumeDecision` refuse a cancelled or completed run structurally, rather than
	 * relying on whoever cancelled the run having remembered to also close its open
	 * decisions.
	 */
	async readRunMeta(): Promise<PersistedRunMeta | null> {
		const dir = this.requireInit()
		try {
			const content = await readFile(join(dir, 'run.json'), 'utf-8')
			return JSON.parse(content) as PersistedRunMeta
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	async writeMessages(run: Run): Promise<void> {
		const dir = this.requireInit()
		await this.commit('write messages.json', () =>
			atomicWriteJson(join(dir, 'messages.json'), run.messages),
		)
	}

	async writeReport(content: string): Promise<string> {
		const dir = this.requireInit()
		const reportPath = join(dir, 'report.md')
		await this.commit('write report.md', () => atomicWriteFile(reportPath, content))
		this.log.info(`Report written: ${reportPath}`)
		return reportPath
	}

	getRunDir(): string | null {
		return this.runDir
	}

	async writeCheckpoint(checkpoint: IterationCheckpoint): Promise<void> {
		const dir = this.requireInit()
		const cpDir = join(dir, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		await this.commit(`write checkpoint ${checkpoint.id}`, () =>
			atomicWriteJson(join(cpDir, `${checkpoint.id}.json`), checkpoint),
		)
	}

	async readCheckpoint(checkpointId: CheckpointId): Promise<IterationCheckpoint | null> {
		const dir = this.requireInit()
		try {
			const content = await readFile(join(dir, 'checkpoints', `${checkpointId}.json`), 'utf-8')
			return JSON.parse(content) as IterationCheckpoint
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	/**
	 * Claim the right to answer one checkpoint's decision. **This is the compare-and-set
	 * the single-use token rests on, and it is the only one.**
	 *
	 * An exclusive create (`wx`) that exactly one caller can win: the filesystem
	 * arbitrates, so it holds across store instances and across processes. Whoever wins
	 * writes the outcome INTO the claim, which is why the losers can be told what the
	 * decision was answered with even before the winner has finished writing it onto the
	 * checkpoint.
	 *
	 * The in-memory lock this replaces could not do the job and said so in its own
	 * docstring: `checkpointLocks` is a `Map` on the store INSTANCE, and every decision
	 * entry point news up its own store — so it serialised a redemption only against
	 * itself. Two concurrent redemptions of one token both read `pending`, both passed
	 * every check, and both drove a resume. A lock that does less than its name promises
	 * is how the next reader ships the race; the guarantee now lives on the record.
	 *
	 * Returns `null` when this caller WON, or the existing claim when it lost. The claim
	 * is never deleted: it is the durable proof that the token is spent.
	 *
	 * `kind` names WHICH right is being claimed, and there are two, because there are two
	 * moments at which one batch could run twice:
	 *
	 *   - `'decision'` — the right to ANSWER. Guards the token.
	 *   - `'execution'` — the right to DISPATCH the answered batch. Guards the resume.
	 *     Redemption hands exactly one caller a `PreparedDecisionResume`, but nothing
	 *     stops that caller (or a retrying route, or a queue that delivered the job
	 *     twice) from driving `query({ resumeFromCheckpoint })` twice: both drives read
	 *     `state: 'resolved'` and both dispatch. Guarding only the token would leave the
	 *     double-execute it exists to prevent reachable one layer down.
	 *
	 * **Known limit.** `wx` is atomic on a local filesystem. On NFS without `O_EXCL`
	 * support it is not, and a deployment spreading one run's directory across such a
	 * mount must serialise redemption above this layer.
	 */
	async claimDecision(
		checkpointId: CheckpointId,
		claim: DecisionClaim,
		kind: 'decision' | 'execution' = 'decision',
	): Promise<DecisionClaim | null> {
		const dir = this.requireInit()
		const claimsDir = join(dir, 'decisions')
		await mkdir(claimsDir, { recursive: true })
		const suffix = kind === 'execution' ? 'execution' : 'claim'
		const claimPath = join(claimsDir, `${checkpointId}.${suffix}.json`)

		try {
			await writeFile(claimPath, JSON.stringify(claim, null, 2), { encoding: 'utf-8', flag: 'wx' })
			return null
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
		}

		try {
			return JSON.parse(await readFile(claimPath, 'utf-8')) as DecisionClaim
		} catch {
			// The claim exists but cannot be read back — a truncated write, a partial disk.
			// The token is still SPENT: a claim we cannot read is not a claim we may
			// overwrite, and refusing without an outcome is the fail-closed reading.
			this.log.warn('Decision claim exists but could not be read — refusing the redemption', {
				checkpointId,
			})
			return { requestId: claim.requestId, at: 0 }
		}
	}

	/** The claim on this checkpoint's decision, if it has been answered. */
	async readDecisionClaim(checkpointId: CheckpointId): Promise<DecisionClaim | null> {
		const dir = this.requireInit()
		try {
			const content = await readFile(join(dir, 'decisions', `${checkpointId}.claim.json`), 'utf-8')
			return JSON.parse(content) as DecisionClaim
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	/**
	 * Read-modify-write one checkpoint under a per-checkpoint lock.
	 *
	 * The lock serialises the run's OWN in-process transitions of a
	 * {@link import('../../types/hitl/index.js').PendingDecision} — `resolved →
	 * executing → settled`, and the journal writes that ride along with them, which the
	 * tool executor fires per settled call. That is all it is for.
	 *
	 * **It is not what makes the resume token single-use.** It cannot be: it is a `Map`
	 * on this instance, and it serialises nothing against another store, another
	 * process, or another worker. {@link claimDecision} is the compare-and-set that
	 * arbitrates redemption, and it does so on the durable record.
	 *
	 * `mutate` returning `undefined` means "no change" and skips the write.
	 */
	async updateCheckpoint(
		checkpointId: CheckpointId,
		mutate: (checkpoint: IterationCheckpoint) => IterationCheckpoint | undefined,
	): Promise<IterationCheckpoint | null> {
		const prev = this.checkpointLocks.get(checkpointId) ?? Promise.resolve()
		let release!: () => void
		const lock = new Promise<void>((r) => {
			release = r
		})
		this.checkpointLocks.set(checkpointId, lock)

		try {
			await prev

			const current = await this.readCheckpoint(checkpointId)
			if (!current) return null

			const next = mutate(current)
			if (!next) return current

			await this.writeCheckpoint(next)
			return next
		} finally {
			release()
			if (this.checkpointLocks.get(checkpointId) === lock) {
				this.checkpointLocks.delete(checkpointId)
			}
		}
	}

	async listCheckpoints(): Promise<IterationCheckpoint[]> {
		const dir = this.requireInit()
		const cpDir = join(dir, 'checkpoints')
		try {
			const files = await readdir(cpDir)
			const checkpoints: IterationCheckpoint[] = []
			for (const file of files) {
				if (!file.endsWith('.json')) continue
				try {
					const content = await readFile(join(cpDir, file), 'utf-8')
					checkpoints.push(JSON.parse(content) as IterationCheckpoint)
				} catch {
					this.log.warn(`Failed to parse checkpoint file: ${file}`)
				}
			}
			return checkpoints.sort((a, b) => a.createdAt - b.createdAt)
		} catch (err) {
			if (isFileNotFound(err)) return []
			throw err
		}
	}

	async deleteCheckpoint(checkpointId: CheckpointId): Promise<void> {
		const dir = this.requireInit()
		try {
			await unlink(join(dir, 'checkpoints', `${checkpointId}.json`))
		} catch (err) {
			if (!isFileNotFound(err)) throw err
		}
	}

	static async listRuns(baseDir: string): Promise<
		Array<{
			id: string
			agentName: string
			status: string
			startedAt: number
			endedAt?: number
		}>
	> {
		try {
			const indexPath = join(baseDir, 'index.json')
			const content = await readFile(indexPath, 'utf-8')
			return JSON.parse(content)
		} catch (err) {
			if (isFileNotFound(err)) return []
			throw err
		}
	}

	/**
	 * The index lock is taken INSIDE the commit, never around it, and the order is the whole
	 * reason: a caller that held the index lock while waiting for the write lock, racing one
	 * that held the write lock while waiting for the index lock, is a deadlock. Every lock in
	 * this store is now acquired commit-first, so there is one order and no cycle.
	 */
	async addToIndex(run: Run): Promise<void> {
		if (run.parentRunId) return

		await this.commit('update index.json', async () => {
			const prev = this.indexLock
			let resolve!: () => void
			this.indexLock = new Promise<void>((r) => {
				resolve = r
			})

			try {
				await prev

				const indexPath = join(this.baseDir, 'index.json')
				let index: Record<string, unknown>[] = []

				try {
					const content = await readFile(indexPath, 'utf-8')
					index = JSON.parse(content)
				} catch (err) {
					if (!isFileNotFound(err)) throw err
				}

				const entry = {
					id: run.id,
					agentId: run.metadata.agentId,
					agentName: run.metadata.agentName,
					model: run.metadata.config.model,
					status: run.status,
					startedAt: run.startedAt,
					endedAt: run.endedAt,
					iterations: run.currentIteration,
					totalTokens: run.tokenUsage.totalTokens,
				}

				const existingIdx = index.findIndex((e) => e.id === run.id)
				if (existingIdx >= 0) {
					index[existingIdx] = entry
				} else {
					index.push(entry)
				}

				await atomicWriteJson(indexPath, index)
			} finally {
				resolve?.()
			}
		})
	}
}

/**
 * Write-then-rename, with a temp name **unique per write**.
 *
 * A fixed `${filePath}.tmp` is only atomic against a single writer. Two writers to one
 * path — two `RunDiskStore` instances (which is the normal shape: `resumeDecision`
 * builds its own), two processes, or two calls the per-instance lock does not span —
 * share that one temp name: A writes it, B overwrites it, A renames it away, and B's
 * rename fails with `ENOENT ... rename('run.json.tmp' -> 'run.json')`. On the decision
 * path that surfaced as a 500 where the errors contract promises a
 * `DecisionAlreadyResolvedError`, so a client could not tell a duplicate submit from a
 * server fault. The rename itself is what makes the write atomic; the temp name only
 * has to be private to this write.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
	try {
		await writeFile(tempPath, content, 'utf-8')
		await rename(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, JSON.stringify(value, null, 2))
}

/**
 * Create a file **with its content**, or fail with `EEXIST`. One step, as far as any
 * concurrent reader is concerned.
 *
 * `writeFile(path, data, { flag: 'wx' })` is not that, and the lease is where it mattered:
 * it opens with `O_CREAT|O_EXCL` and then writes in a SECOND syscall, so between the two
 * the lease file exists and is EMPTY. Every reader of the current lease — another
 * `acquireLease`, a redemption's lease check, an operator's `readRunLease`, the incumbent's
 * own fence — lands on `JSON.parse('')` and gets an untyped `SyntaxError`. And the window
 * is exactly the takeover, which is precisely when concurrent readers are most likely.
 *
 * `link()` is the fix and it is the classic one: the content is written to a private temp
 * name first, and the link is what publishes it. The link either exists with the whole
 * record behind it or does not exist at all — there is no third state — and it still fails
 * with `EEXIST` when somebody else got there first, so the arbitration the lease depends on
 * is unchanged. (Every other durable write in this store already went through
 * write-then-rename for the same reason. The lease was the one that did not.)
 */
async function atomicCreateFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(tempPath, content, 'utf-8')
	try {
		await link(tempPath, filePath)
	} finally {
		await unlink(tempPath).catch(() => undefined)
	}
}

/** How long a lock file has existed, or `null` if it is already gone. */
async function lockAgeMs(lockPath: string): Promise<number | null> {
	try {
		const info = await stat(lockPath)
		return Date.now() - info.mtimeMs
	} catch (err) {
		if (isFileNotFound(err)) return null
		throw err
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function isFileNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
