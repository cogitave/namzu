import type { ToolRegistry } from '../../registry/tool/execute.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { Logger } from '../../utils/logger.js'
import { ToolExecutor } from './executor.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export interface ToolingBootstrapConfig {
	tools: ToolRegistry
	runId: RunId
	workingDirectory: string
	permissionMode: PermissionMode
	env: Record<string, string>
	abortSignal: AbortSignal
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
			},
			activityStore,
			emitEvent,
			log,
		)
	}
}
