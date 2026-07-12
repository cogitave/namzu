import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointId, DecisionClaim, IterationCheckpoint } from '../../types/hitl/index.js'
import type { PersistedRunMeta, Run, RunEvent, RunStoreConfig } from '../../types/run/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class RunDiskStore {
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private indexLock: Promise<void> = Promise.resolve()
	private checkpointLocks = new Map<CheckpointId, Promise<void>>()

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
		await atomicWriteJson(join(dir, 'messages.json'), run.messages)
	}

	async writeReport(content: string): Promise<string> {
		const dir = this.requireInit()

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
