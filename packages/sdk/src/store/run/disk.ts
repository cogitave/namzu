import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
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
	type RunLeaseView,
} from '../../types/run/lease.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class RunDiskStore {
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private indexLock: Promise<void> = Promise.resolve()
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

		// Bounded retry: each failed `wx` means somebody else took the token we wanted, so
		// the next read shows THEM as the holder and we refuse. The loop exists for the one
		// case where that is not true — a taker that crashed between creating its file and
		// nothing else, leaving a token nobody is renewing — where the next attempt simply
		// takes the token above it.
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
				await writeFile(this.leasePath(lease.token), JSON.stringify(lease, null, 2), {
					encoding: 'utf-8',
					flag: 'wx',
				})
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
			return lease
		}

		// Five consecutive losses of the create race with nobody holding the result. This
		// is not a state the filesystem should be able to produce; refusing is the only
		// honest answer, because the alternative is to write under a token we did not win.
		throw new Error(
			`Could not acquire the lease for run ${runId}: the fencing token kept being taken from under us. Retry.`,
		)
	}

	/**
	 * Heartbeat. Refuses with {@link RunLeaseLostError} if the run has been taken over —
	 * which is how a stalled segment finds out it no longer owns the run it thinks it is
	 * driving, and can stop before it does any more work.
	 */
	async renewLease(): Promise<RunLease> {
		const held = this.lease
		if (!held) throw new Error('renewLease() called without a lease — acquireLease() first')

		await this.assertFence('renew the lease')

		const renewed: RunLease = { ...held, renewedAt: Date.now() }
		await atomicWriteJson(this.leasePath(held.token), renewed)
		this.lease = renewed
		return renewed
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

		const current = await this.readCurrentLease()
		if (!current || current.token !== held.token) {
			this.log.warn('Not releasing a lease this segment no longer holds — the run was taken over', {
				runId: held.runId,
				heldToken: held.token,
				currentToken: current?.token ?? 0,
			})
			return
		}

		await atomicWriteJson(this.leasePath(held.token), { ...held, releasedAt: Date.now() })
	}

	/** The lease this store writes under, if any. */
	getLease(): RunLease | null {
		return this.lease
	}

	private leasePath(token: number): string {
		return join(this.leasesDir(), `${String(token).padStart(6, '0')}.json`)
	}

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

		try {
			return JSON.parse(await readFile(this.leasePath(highest), 'utf-8')) as RunLease
		} catch (err) {
			if (isFileNotFound(err)) return null
			throw err
		}
	}

	/**
	 * **The fence.** Every write a SEGMENT makes passes through here first.
	 *
	 * The check is a fact on disk, not a fact in memory: a stalled process believes it
	 * holds the lease right up to the moment it is told otherwise, so asking it is
	 * worthless. It re-reads the current token and refuses if it is not the one it holds.
	 *
	 * A store with no lease is the control plane (cancel, redemption, operator reads) and
	 * is deliberately not fenced — see {@link lease}.
	 *
	 * `transcript.jsonl` is deliberately NOT fenced: it is append-only, so a superseded
	 * segment's events cannot destroy the new segment's, and refusing them would throw
	 * away the evidence of what the stalled process was doing. Everything that REPLACES a
	 * file — the run meta, the messages, the checkpoints, the index — is fenced.
	 */
	private async assertFence(operation: string): Promise<void> {
		const held = this.lease
		if (!held) return

		const current = await this.readCurrentLease()
		const currentToken = current?.token ?? 0
		if (currentToken !== held.token) {
			throw new RunLeaseLostError(held.runId, held.token, currentToken, operation)
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
		await this.assertFence('write run.json')

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

		await atomicWriteJson(join(dir, 'run.json'), meta)
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
		await this.assertFence('update run.json')
		const current = await this.readRunMeta()
		if (!current) return null

		const next = mutate(current)
		if (!next) return current

		await atomicWriteJson(join(dir, 'run.json'), next)
		return next
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
		await this.assertFence('write messages.json')
		await atomicWriteJson(join(dir, 'messages.json'), run.messages)
	}

	async writeReport(content: string): Promise<string> {
		const dir = this.requireInit()
		await this.assertFence('write report.md')

		const reportPath = join(dir, 'report.md')
		await atomicWriteFile(reportPath, content)
		this.log.info(`Report written: ${reportPath}`)
		return reportPath
	}

	getRunDir(): string | null {
		return this.runDir
	}

	async writeCheckpoint(checkpoint: IterationCheckpoint): Promise<void> {
		const dir = this.requireInit()
		await this.assertFence(`write checkpoint ${checkpoint.id}`)
		const cpDir = join(dir, 'checkpoints')
		await mkdir(cpDir, { recursive: true })
		await atomicWriteJson(join(cpDir, `${checkpoint.id}.json`), checkpoint)
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

	async addToIndex(run: Run): Promise<void> {
		if (run.parentRunId) return
		await this.assertFence('update index.json')

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

function isFileNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
