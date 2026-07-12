import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
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

		await atomicWriteJson(join(dir, 'run.json'), meta)
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
	 * Read-modify-write one checkpoint under a per-checkpoint lock.
	 *
	 * Every transition of a {@link import('../../types/hitl/index.js').PendingDecision}
	 * is a compare-and-set on a file, and a plain read-then-write would let two
	 * concurrent redemptions of the same token both observe `pending` and both proceed.
	 * The lock serialises them **within this store instance**, which is what makes the
	 * single-use token single-use for an in-process caller.
	 *
	 * **Known limit, and it is a real one.** This is not a cross-process CAS. Two
	 * worker processes holding their own `RunDiskStore` for the same run can still
	 * interleave a read and a write, and nothing here stops them — the store has no
	 * CAS and no fencing token (`ses_017` open question #17). A multi-worker deployment
	 * must serialise decision redemption above this layer (the decisions route owns the
	 * atomic `pending → resolved` transition per plan §D1) and must not treat this lock
	 * as the guarantee. Stated rather than papered over: a lock that silently does less
	 * than its name promises is how the next reader ships the race.
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

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.tmp`
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
