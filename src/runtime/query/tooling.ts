import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
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
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
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
				invocationState: config.invocationState,
				pluginManager: config.pluginManager,
			},
			activityStore,
			emitEvent,
			log,
		)
	}
}
