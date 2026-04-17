import { join } from 'node:path'
import { PlanManager } from '../../manager/plan/lifecycle.js'
import { RunPersistence } from '../../manager/run/persistence.js'
import { DefaultPathBuilder, type PathBuilder } from '../../session/workspace/path-builder.js'
import { ActivityStore } from '../../store/activity/memory.js'
import { type ActivityTrackingConfig, resolveActivityTracking } from '../../types/activity/index.js'
import type { RunId, SessionId, TenantId, ThreadId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { AgentRunConfig } from '../../types/run/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import type { ModelPricing } from '../../utils/cost.js'
import { generateRunId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

/**
 * Config accepted by {@link RunContextFactory.build}. Phase 6 promotes
 * `sessionId`, `projectId`, and `tenantId` to required — runs are scoped
 * under a Session within a Project within a Tenant (session-hierarchy.md
 * §12.1). `threadId` is retained only as a deprecated compat alias of
 * `projectId` — consumers can still pass it, but no new path layout honors it.
 *
 * `pathBuilder` is optional; when absent a {@link DefaultPathBuilder} is
 * constructed against `{workingDirectory}/.namzu` — no more hardcoded
 * `.namzu/threads` path.
 */
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

	sessionId: SessionId
	projectId: ProjectId
	tenantId: TenantId

	pathBuilder?: PathBuilder

	runId?: RunId

	parentRunId?: RunId

	depth?: number
}

/**
 * Result of {@link RunContextFactory.build}. `threadId` remains as a
 * deprecated read-only mirror of `projectId` for consumers still referencing
 * the old name — scheduled for removal in 0.3.0 (session-hierarchy.md §13.1).
 */
export interface RunContext {
	runId: RunId
	sessionId: SessionId
	projectId: ProjectId
	tenantId: TenantId
	/**
	 * @deprecated Mirrors `projectId` — remove when callers migrate off the
	 * legacy name.
	 */
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

		const pathBuilder = config.pathBuilder ?? new DefaultPathBuilder(join(cwd, '.namzu'))
		const outputDir = pathBuilder.sessionDir(config.projectId, config.sessionId)
		const runsDir = join(outputDir, 'runs')

		const log = getRootLogger().child({
			component: 'query',
			agent: config.agentName,
			runId,
			sessionId: config.sessionId,
			projectId: config.projectId,
			tenantId: config.tenantId,
		})

		const runMgr = new RunPersistence({
			runId,
			agentId: config.agentId,
			agentName: config.agentName,
			runConfig: config.runConfig,
			providerId: config.provider.id,
			outputDir: runsDir,
			pricing: config.pricing,
			log,
			sessionId: config.sessionId,
			tenantId: config.tenantId,
			projectId: config.projectId,
			parentRunId: config.parentRunId,
			depth: config.depth,
		})

		const trackingConfig = resolveActivityTracking(permissionMode, config.enableActivityTracking)
		const activityStore = new ActivityStore(runId, trackingConfig)
		const planManager = new PlanManager(runId)

		return {
			runId,
			sessionId: config.sessionId,
			projectId: config.projectId,
			tenantId: config.tenantId,
			threadId: config.projectId as ThreadId,
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
