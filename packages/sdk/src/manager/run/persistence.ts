import { RunDiskStore } from '../../store/run/disk.js'
import {
	type CostInfo,
	EMPTY_TOKEN_USAGE,
	type TokenUsage,
	accumulateTokenUsage,
} from '../../types/common/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { AssistantMessage, Message } from '../../types/message/index.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { AgentRun, StopReason } from '../../types/run/index.js'
import type { RunPersistenceConfig } from '../../types/run/index.js'
import { type ModelPricing, ZERO_COST, accumulateCost } from '../../utils/cost.js'
import { generateEmergencySaveId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'

export class RunPersistence {
	private run: AgentRun
	private runStore: RunDiskStore
	private pricing?: ModelPricing
	private log: Logger

	constructor(config: RunPersistenceConfig) {
		this.pricing = config.pricing
		this.log = config.log

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

	getRun(): Readonly<AgentRun> {
		return this.run
	}

	getSession(): Readonly<AgentRun> {
		return this.run
	}

	getRunStore(): RunDiskStore {
		return this.runStore
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

export const SessionManager = RunPersistence

export type SessionManager = RunPersistence
