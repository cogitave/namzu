import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { AgentRun, RunEvent, RunStoreConfig } from '../../types/run/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class RunDiskStore {
	private baseDir: string
	private runDir: string | null = null
	private log: Logger
	private indexLock: Promise<void> = Promise.resolve()

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

	async writeRunMeta(run: AgentRun): Promise<void> {
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

	async writeMessages(run: AgentRun): Promise<void> {
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

	async addToIndex(run: AgentRun): Promise<void> {
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

export const SessionStore = RunDiskStore

export type SessionStore = RunDiskStore
