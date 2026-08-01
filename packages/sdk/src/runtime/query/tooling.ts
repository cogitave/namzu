import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { Logger } from '../../utils/logger.js'
import { ToolExecutor } from './executor.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export interface ToolingBootstrapConfig {
	tools: ToolRegistryContract
	runId: RunId
	workingDirectory: string
	permissionMode: PermissionMode
	env: Record<string, string>
	abortSignal: AbortSignal
	allowedTools?: readonly string[]
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
	toolTimeoutMs?: number
	maxToolConcurrency?: number
	maxToolOutputChars?: number
	toolOutputDir?: string
	repairToolCall?: RepairToolCall
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
				...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
				...(config.maxToolConcurrency !== undefined
					? { maxToolConcurrency: config.maxToolConcurrency }
					: {}),
				...(config.maxToolOutputChars !== undefined
					? { maxToolOutputChars: config.maxToolOutputChars }
					: {}),
				...(config.toolOutputDir !== undefined ? { toolOutputDir: config.toolOutputDir } : {}),
				...(config.repairToolCall !== undefined ? { repairToolCall: config.repairToolCall } : {}),
			},
			activityStore,
			emitEvent,
			log,
		)
	}
}
