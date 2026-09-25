import type { AuthorizationGate } from '../../authorization/gate.js'
import type { SkillGrantSet } from '../../authorization/skill-grant.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { ToolManager } from '../../toolsets/manager.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { AuditEventInput } from '../../types/session/audit.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { RequestToolPause, SkillRegistryRef } from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { BackoffPolicy } from '../../utils/backoff.js'
import type { Logger } from '../../utils/logger.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import { ToolExecutor } from './executor.js'

import type { EmitEvent } from './events.js'

export interface ToolingBootstrapConfig {
	fileReadTracker?: import('../../types/tool/index.js').FileReadTracker
	tools: ToolManager
	sessionId: SessionId
	turnId: TurnId
	workingDirectory: string
	/** See `QueryParams.additionalDirectories`. */
	additionalDirectories?: readonly string[]
	/** See `QueryParams.outsideRootAccess`. */
	outsideRootAccess?: 'refuse' | 'review'
	/** See `QueryParams.sandboxEscape`. */
	sandboxEscape?: 'refuse' | 'review'
	/** A resolver, so an approval inside a turn can change it. See the executor. */
	permissionMode: PermissionMode | (() => PermissionMode)
	env: Record<string, string>
	abortSignal: AbortSignal
	allowedTools?: readonly string[]
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
	toolTimeoutMs?: number
	/** Host-owned and shared; the executor binds it to this turn. */
	backgroundJobs?: BackgroundJobRegistry
	/** See `QueryParams.backgroundJobOwner`. */
	backgroundJobOwner?: string
	/** Where `wait_for_job` records wait-intent; see the executor's own field. */
	onJobAwaited?: (id: string) => void
	/** Where the `skill` tool reads from. */
	skills?: SkillRegistryRef
	/** How this turn reaches the web. */
	web?: import('../../types/tool/index.js').ToolContext['web']
	toolRetryBackoff?: Partial<BackoffPolicy>
	maxToolConcurrency?: number
	maxToolCalls?: number
	readToolCallBudgetRecords?: () => Promise<readonly SessionRecord[]>
	maxToolOutputChars?: number
	/** See `QueryParams.toolResultGuardrails`. Absent installs the shipped default; a registry's own win. */
	toolResultGuardrails?: readonly import('../../types/guardrail/index.js').ToolResultGuardrailSpec[]
	retainedToolPreviewChars?: number
	maxToolContentBytes?: number
	captureSessionEvidence?: import('../../types/tool/index.js').ToolContext['captureSessionEvidence']
	toolOutputDir?: string | (() => string | undefined)
	repairToolCall?: RepairToolCall
	/** Operator authorization shared with the direct-call review path. */
	authorizationGate?: AuthorizationGate
	/** Durable refusal recorder for nested authorization decisions. */
	recordAudit?: (input: AuditEventInput) => Promise<unknown>
	/** Builds the durable-pause seam for one tool call; see ToolContext.requestPause. */
	toolPause?: (toolUseId: string) => RequestToolPause
	/** The turn's skill pre-approvals; see the executor's own field. */
	skillGrants?: SkillGrantSet
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
				...(config.fileReadTracker ? { fileReadTracker: config.fileReadTracker } : {}),
				sessionId: config.sessionId,
				turnId: config.turnId,
				workingDirectory: config.workingDirectory,
				...(config.additionalDirectories?.length
					? { additionalDirectories: config.additionalDirectories }
					: {}),
				...(config.outsideRootAccess ? { outsideRootAccess: config.outsideRootAccess } : {}),
				...(config.sandboxEscape ? { sandboxEscape: config.sandboxEscape } : {}),
				permissionMode: config.permissionMode,
				env: config.env,
				abortSignal: config.abortSignal,
				allowedTools: config.allowedTools,
				invocationState: config.invocationState,
				captureSessionEvidence: config.captureSessionEvidence,
				pluginManager: config.pluginManager,
				...(config.backgroundJobs ? { backgroundJobs: config.backgroundJobs } : {}),
				...(config.backgroundJobOwner ? { backgroundJobOwner: config.backgroundJobOwner } : {}),
				...(config.onJobAwaited ? { onJobAwaited: config.onJobAwaited } : {}),
				...(config.skills ? { skills: config.skills } : {}),
				...(config.web ? { web: config.web } : {}),
				...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
				...(config.toolRetryBackoff !== undefined
					? { toolRetryBackoff: config.toolRetryBackoff }
					: {}),
				...(config.maxToolCalls !== undefined ? { maxToolCalls: config.maxToolCalls } : {}),
				...(config.readToolCallBudgetRecords
					? { readToolCallBudgetRecords: config.readToolCallBudgetRecords }
					: {}),
				...(config.maxToolConcurrency !== undefined
					? { maxToolConcurrency: config.maxToolConcurrency }
					: {}),
				...(config.maxToolOutputChars !== undefined
					? { maxToolOutputChars: config.maxToolOutputChars }
					: {}),
				...(config.toolResultGuardrails !== undefined
					? { toolResultGuardrails: config.toolResultGuardrails }
					: {}),
				...(config.retainedToolPreviewChars !== undefined
					? { retainedToolPreviewChars: config.retainedToolPreviewChars }
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
				...(config.skillGrants !== undefined ? { skillGrants: config.skillGrants } : {}),
			},
			activityStore,
			emitEvent,
			log,
		)
	}
}
