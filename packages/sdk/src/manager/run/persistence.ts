import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { RunDiskStore } from '../../store/run/disk.js'
import { type CostInfo, type TokenUsage, accumulateTokenUsage } from '../../types/common/index.js'
import type { IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { AssistantMessage, Message } from '../../types/message/index.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { Run, RunPersistenceConfig, StopReason } from '../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import { type ModelPricing, ZERO_COST, accumulateCost } from '../../utils/cost.js'
import { generateEmergencySaveId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'

export class RunPersistence {
	private run: Run
	private runStore: RunDiskStore
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

	getRunDir(): string | null {
		return this.runStore.getRunDir()
	}

	/**
	 * Create/attach the run's directory without writing anything into it.
	 *
	 * Split out of {@link init} for the resume path: the checkpoint being
	 * resumed from lives under this run's own directory, so the store has to
	 * know that directory before the checkpoint can be read — but the run's
	 * accounting must be hydrated from that checkpoint BEFORE `init()` stamps
	 * the meta file, or `init()` writes a zeroed `run.json` over the real one.
	 * Idempotent; `init()` calls it too.
	 */
	async openRunDir(): Promise<void> {
		await this.runStore.initRun(this.run.id, this.run.parentRunId)
	}

	async init(): Promise<void> {
		await this.openRunDir()
		await this.runStore.writeRunMeta(this.run)
	}

	/**
	 * Hydrate the run's accounting from the checkpoint it is being resumed
	 * from. Without this a resumed run starts on a blank ledger, which means
	 * `tokenBudget` and `costLimitUsd` are re-granted in full on every resume —
	 * a run stopped at its cost cap could be resumed forever, each time with a
	 * fresh allowance to spend.
	 *
	 * **These are LIFETIME limits of the logical run, accumulated across
	 * resumes.** A run that has already spent 90% of its token budget resumes
	 * with 10% left, and a run that is already at its cost cap resumes only to
	 * stop immediately. The guard's time budget is restored alongside this, on
	 * ACTIVE-execution-time semantics — see
	 * {@link import('../../runtime/query/guard.js').GuardCoordinator.restoreElapsed}.
	 *
	 * `guardState.iterationCount` is the authority for the iteration counter,
	 * not `checkpoint.iteration`: the latter is the label the creating phase
	 * passed (the plan gate writes `0` while the run may be mid-loop), the
	 * former is the run's own counter at snapshot time.
	 *
	 * What this does NOT restore, deliberately:
	 *   - `startedAt` stays this segment's start — a synthetic "start" that
	 *     back-dates calendar time to make some elapsed sum work out would lie
	 *     to every consumer that reads it as a timestamp. Active elapsed lives
	 *     on the guard, which is the thing that actually meters it.
	 *   - `messages` — the caller seeds those through `prepareResumeMessages`,
	 *     which repairs dangling tool pairs first.
	 *
	 * Defensive reads: a checkpoint is JSON that some older writer put on disk,
	 * so it is not really guaranteed to match the current type. Missing usage /
	 * cost / guard state degrades to zero rather than to `undefined` leaking
	 * into arithmetic and making every limit comparison `NaN` — i.e. silently
	 * disabling the budget checks this method exists to enforce.
	 */
	restoreFromCheckpoint(checkpoint: IterationCheckpoint): void {
		this.run.tokenUsage = { ...EMPTY_TOKEN_USAGE, ...checkpoint.tokenUsage }
		this.run.costInfo = { ...ZERO_COST, ...checkpoint.costInfo }
		this.run.currentIteration = Math.max(0, checkpoint.guardState?.iterationCount ?? 0)

		this.log.info('Run accounting restored from checkpoint', {
			runId: this.run.id,
			checkpointId: checkpoint.id,
			totalTokens: this.run.tokenUsage.totalTokens,
			totalCost: this.run.costInfo.totalCost,
			currentIteration: this.run.currentIteration,
			activeElapsedMs: checkpoint.guardState?.elapsedMs ?? 0,
		})
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

	/**
	 * Park the run: it is waiting on a decision from outside itself and cannot
	 * progress until one arrives.
	 *
	 * The three things this deliberately does NOT do are the whole point:
	 *
	 *   - **No `endedAt`.** The run has not ended. A timestamp here would make
	 *     every consumer that computes a duration, or that reads `endedAt` as
	 *     "is it over", treat a waiting run as a finished one — which is exactly
	 *     the bug this state exists to close.
	 *   - **No `resolveResult()`.** A suspended run has no answer yet. Promoting
	 *     the last assistant message to `result` would publish a half-finished
	 *     turn (typically the very message whose tool calls are awaiting review)
	 *     as the run's output.
	 *   - **No completion event.** The caller emits `run_paused`; `run_completed`
	 *     must never fire for a run that is still going to run again.
	 *
	 * `stopReason: 'paused'` is a label, not a state. It is set here for the
	 * benefit of readers, but nothing may infer terminality from it — see
	 * {@link import('../../types/run/disposition.js').RunDisposition}.
	 */
	markSuspended(): void {
		this.run.status = 'awaiting_input'
		this.run.stopReason = 'paused'
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
		const lastAssistant = [...this.run.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant' && m.content !== null)

		if (lastAssistant?.content) {
			this.run.result = lastAssistant.content
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
