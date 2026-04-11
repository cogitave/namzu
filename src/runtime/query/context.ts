import { join } from 'node:path'
import { PlanManager } from '../../manager/plan/lifecycle.js'
import { RunPersistence } from '../../manager/run/persistence.js'
import { ActivityStore } from '../../store/activity/memory.js'
import { type ActivityTrackingConfig, resolveActivityTracking } from '../../types/activity/index.js'
import type { RunId, ThreadId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { AgentRunConfig } from '../../types/run/index.js'
import type { ModelPricing } from '../../utils/cost.js'
import { generateRunId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'
import { getRootLogger } from '../../utils/logger.js'

export interface RunContextConfig {
	agentId: string
	agentName: string
	runConfig: AgentRunConfig
	provider: LLMProvider
	workingDirectory?: string
	pricing?: ModelPricing
	enableActivityTracking?: boolean
	messages: Message[]
	signal?: AbortSignal

	threadId: ThreadId

	runId?: RunId

	parentRunId?: RunId

	depth?: number
}

export interface RunContext {
	runId: RunId
	threadId: ThreadId
	runMgr: RunPersistence
	activityStore: ActivityStore
	planManager: PlanManager
	abortController: AbortController
	cwd: string
	outputDir: string
	permissionMode: PermissionMode
	log: Logger
	trackingConfig: ActivityTrackingConfig
}

export class RunContextFactory {
	static build(config: RunContextConfig): RunContext {
		const abortController = new AbortController()
		if (config.signal) {
			config.signal.addEventListener('abort', () => abortController.abort(), { once: true })
		}

		const cwd = config.workingDirectory ?? process.cwd()
		const permissionMode = config.runConfig.permissionMode ?? 'auto'
		const runId = config.runId ?? generateRunId()

		if (!config.threadId) {
			throw new Error('threadId is required for run persistence — all runs must belong to a thread')
		}
		const threadId: ThreadId = config.threadId
		const outputDir = join(cwd, '.namzu', 'threads', threadId, 'runs')

		const log = getRootLogger().child({
			component: 'query',
			agent: config.agentName,
			runId,
			threadId,
		})

		const runMgr = new RunPersistence({
			runId,
			agentId: config.agentId,
			agentName: config.agentName,
			runConfig: config.runConfig,
			providerId: config.provider.id,
			outputDir,
			pricing: config.pricing,
			log,
			parentRunId: config.parentRunId,
			depth: config.depth,
		})

		const trackingConfig = resolveActivityTracking(permissionMode, config.enableActivityTracking)
		const activityStore = new ActivityStore(runId, trackingConfig)
		const planManager = new PlanManager(runId)

		return {
			runId,
			threadId,
			runMgr,
			activityStore,
			planManager,
			abortController,
			cwd,
			outputDir,
			permissionMode,
			log,
			trackingConfig,
		}
	}
}
