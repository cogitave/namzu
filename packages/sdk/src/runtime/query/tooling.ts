import type { AuthorizationGate } from '../../authorization/gate.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { AuditEventInput } from '../../types/run/audit.js'
import type { RunEvent } from '../../types/run/index.js'
import type {
	RequestToolPause,
	SkillRegistryRef,
	ToolRegistryContract,
} from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { BackoffPolicy } from '../../utils/backoff.js'
import type { Logger } from '../../utils/logger.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import { ToolExecutor } from './executor.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export interface ToolingBootstrapConfig {
	tools: ToolRegistryContract
	runId: RunId
	workingDirectory: string
	/** A resolver, so an approval inside a run can change it. See the executor. */
	permissionMode: PermissionMode | (() => PermissionMode)
	env: Record<string, string>
	abortSignal: AbortSignal
	allowedTools?: readonly string[]
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
	toolTimeoutMs?: number
	/** Host-owned and shared; the executor binds it to this run. */
	backgroundJobs?: BackgroundJobRegistry
	/** Where the `skill` tool reads from. */
	skills?: SkillRegistryRef
	/** How this run reaches the web. */
	web?: import('../../types/tool/index.js').ToolContext['web']
	toolRetryBackoff?: Partial<BackoffPolicy>
	maxToolConcurrency?: number
	maxToolOutputChars?: number
	maxToolContentBytes?: number
	toolOutputDir?: string
	repairToolCall?: RepairToolCall
	/** Operator authorization shared with the direct-call review path. */
	authorizationGate?: AuthorizationGate
	/** Durable refusal recorder for nested authorization decisions. */
	recordAudit?: (input: AuditEventInput) => Promise<unknown>
	/** Builds the durable-pause seam for one tool call; see ToolContext.requestPause. */
	toolPause?: (toolUseId: string) => RequestToolPause
}

export class ToolingBootstrap {
	static init(
		config: ToolingBootstrapConfig,
		activityStore: ActivityStore,
		emitEvent: EmitEvent,
		log: Logger,
	): ToolExecutor {
		return new ToolExecutor(
			{
				tools: config.tools,
				runId: config.runId,
				workingDirectory: config.workingDirectory,
				permissionMode: config.permissionMode,
				env: config.env,
				abortSignal: config.abortSignal,
				allowedTools: config.allowedTools,
				invocationState: config.invocationState,
				pluginManager: config.pluginManager,
				...(config.backgroundJobs ? { backgroundJobs: config.backgroundJobs } : {}),
				...(config.skills ? { skills: config.skills } : {}),
				...(config.web ? { web: config.web } : {}),
				...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
				...(config.toolRetryBackoff !== undefined
					? { toolRetryBackoff: config.toolRetryBackoff }
					: {}),
				...(config.maxToolConcurrency !== undefined
					? { maxToolConcurrency: config.maxToolConcurrency }
					: {}),
				...(config.maxToolOutputChars !== undefined
					? { maxToolOutputChars: config.maxToolOutputChars }
					: {}),
				...(config.maxToolContentBytes !== undefined
					? { maxToolContentBytes: config.maxToolContentBytes }
					: {}),
				...(config.toolOutputDir !== undefined ? { toolOutputDir: config.toolOutputDir } : {}),
				...(config.repairToolCall !== undefined ? { repairToolCall: config.repairToolCall } : {}),
				...(config.authorizationGate !== undefined
					? { authorizationGate: config.authorizationGate }
					: {}),
				...(config.recordAudit !== undefined ? { recordAudit: config.recordAudit } : {}),
				...(config.toolPause !== undefined ? { toolPause: config.toolPause } : {}),
			},
			activityStore,
			emitEvent,
			log,
		)
	}
}
