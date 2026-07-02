import { AUTO_CONTINUATION_USER_MESSAGE } from '../../constants/continuation.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { DiskCheckpointStore } from '../../store/run/checkpoint-disk.js'
import { RunDiskStore } from '../../store/run/disk.js'
import { type CostInfo, type TokenUsage, accumulateTokenUsage } from '../../types/common/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { Run, RunPersistenceConfig, StopReason } from '../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import { type ModelPricing, ZERO_COST, accumulateCost } from '../../utils/cost.js'
import { generateEmergencySaveId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'

export class RunPersistence {
	private run: Run
	private runStore: RunDiskStore
	private checkpointStore: CheckpointStore
	private pricing?: ModelPricing
	private log: Logger
	private readonly _sessionId: SessionId
	private readonly _threadId: ThreadId
	private readonly _tenantId: TenantId
	private readonly _projectId: ProjectId

	constructor(config: RunPersistenceConfig) {
		this.pricing = config.pricing
		this.log = config.log
		this._sessionId = config.sessionId
		this._threadId = config.threadId
		this._tenantId = config.tenantId
		this._projectId = config.projectId

		this.runStore = new RunDiskStore({
			baseDir: config.outputDir,
			logger: config.log,
		})

		// Checkpoints go through the injectable seam; the disk layout under
		// `outputDir` (same tree the runStore writes to) stays the default.
		this.checkpointStore =
			config.checkpointStore ??
			new DiskCheckpointStore({
				baseDir: config.outputDir,
				logger: config.log,
			})

		this.run = {
			id: config.runId,
			status: 'idle',
			metadata: {
				agentId: config.agentId,
				agentName: config.agentName,
				config: config.runConfig,
				provider: config.providerId,
			},
			messages: [],
			tokenUsage: { ...EMPTY_TOKEN_USAGE },
			costInfo: { ...ZERO_COST },
			currentIteration: 0,
			startedAt: Date.now(),
			parentRunId: config.parentRunId,
			depth: config.depth,
		}
	}

	get id(): RunId {
		return this.run.id
	}

	get sessionId(): SessionId {
		return this._sessionId
	}

	get threadId(): ThreadId {
		return this._threadId
	}

	get tenantId(): TenantId {
		return this._tenantId
	}

	get projectId(): ProjectId {
		return this._projectId
	}

	get status() {
		return this.run.status
	}

	get stopReason() {
		return this.run.stopReason
	}

	get messages(): Message[] {
		return this.run.messages
	}

	get tokenUsage(): TokenUsage {
		return this.run.tokenUsage
	}

	get costInfo(): CostInfo {
		return this.run.costInfo
	}

	get currentIteration(): number {
		return this.run.currentIteration
	}

	getRun(): Readonly<Run> {
		return this.run
	}

	getSession(): Readonly<Run> {
		return this.run
	}

	getRunStore(): RunDiskStore {
		return this.runStore
	}

	/**
	 * Checkpoint persistence for this run — the injected
	 * {@link CheckpointStore} when the host provided one, otherwise the
	 * disk default. Pair with {@link getRunScope} when constructing a
	 * `CheckpointManager`.
	 */
	getCheckpointStore(): CheckpointStore {
		return this.checkpointStore
	}

	/** Full five-layer scope key for this run's checkpoint operations. */
	getRunScope(): CheckpointRunScope {
		return {
			tenantId: this._tenantId,
			projectId: this._projectId,
			sessionId: this._sessionId,
			runId: this.run.id,
			parentRunId: this.run.parentRunId,
		}
	}

	getRunDir(): string | null {
		return this.runStore.getRunDir()
	}

	async init(): Promise<void> {
		await this.runStore.initRun(this.run.id, this.run.parentRunId)
		await this.runStore.writeRunMeta(this.run)
	}

	markRunning(): void {
		this.run.status = 'running'
	}

	markCompleted(stopReason?: StopReason): void {
		this.run.status = 'completed'
		if (stopReason) {
			this.run.stopReason = stopReason
		}
		this.run.endedAt = Date.now()
		this.resolveResult()
	}

	markFailed(error: string): void {
		this.run.status = 'failed'
		this.run.stopReason = 'error'
		this.run.lastError = error
		this.run.endedAt = Date.now()
	}

	markCancelled(): void {
		this.run.status = 'cancelled'
		this.run.stopReason = 'cancelled'
		this.run.endedAt = Date.now()
	}

	setStopReason(reason: StopReason): void {
		this.run.stopReason = reason
	}

	setLastError(error: string): void {
		this.run.lastError = error
	}

	incrementIteration(): number {
		this.run.currentIteration++
		return this.run.currentIteration
	}

	pushMessage(message: Message): void {
		this.run.messages.push(message)
	}

	accumulateUsage(usage: TokenUsage): void {
		this.run.tokenUsage = accumulateTokenUsage(this.run.tokenUsage, usage)

		if (this.pricing) {
			this.run.costInfo = accumulateCost(this.run.costInfo, usage, this.pricing)
		}
	}

	private resolveResult(): void {
		// Walk the tail of the message log to assemble the final
		// assistant output. The iteration loop's auto-continuation
		// path (see `runtime/query/iteration/index.ts`) inserts a
		// synthetic user prompt — exactly equal to
		// `AUTO_CONTINUATION_USER_MESSAGE` — between two assistant
		// messages whenever a turn ended with
		// `stop_reason: max_tokens` mid-text. Treat that synthetic
		// user as transparent: keep collecting assistant content past
		// it so the run's persisted `result` carries the full
		// multi-turn output, not just the trailing continuation
		// chunk. Stops at the first non-assistant, non-marker
		// message (e.g. the real user prompt that started the run,
		// or a tool message between turns).
		const chunks: string[] = []
		for (let i = this.run.messages.length - 1; i >= 0; i--) {
			const msg = this.run.messages[i]
			if (!msg) continue
			if (msg.role === 'assistant') {
				if (msg.content !== null) chunks.push(msg.content)
				continue
			}
			if (msg.role === 'user' && msg.content === AUTO_CONTINUATION_USER_MESSAGE) {
				// Synthetic continuation prompt — skip and keep
				// collecting the partial that preceded it.
				continue
			}
			break
		}

		if (chunks.length > 0) {
			// chunks were collected newest-first; reverse so the
			// assembled string is chronological.
			this.run.result = chunks.reverse().join('')
		}
	}

	toEmergencySnapshot(signal: string): EmergencySaveData {
		return {
			id: generateEmergencySaveId(),
			runId: this.run.id,
			messages: this.run.messages,
			tokenUsage: this.run.tokenUsage,
			currentIteration: this.run.currentIteration,
			startedAt: this.run.startedAt,
			savedAt: Date.now(),
			processSignal: signal,
			lastError: this.run.lastError,
		}
	}

	async persist(): Promise<void> {
		await this.runStore.writeRunMeta(this.run)
		await this.runStore.writeMessages(this.run)
		await this.runStore.addToIndex(this.run)

		if (this.run.result) {
			await this.runStore.writeReport(this.run.result)
		}

		this.log.info('Run persisted to disk', {
			runId: this.run.id,
			dir: this.runStore.getRunDir(),
		})
	}
}
