import { extractFromToolCall, extractFromToolResult } from '../../compaction/extractor.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import type { ToolRegistry } from '../../registry/tool/execute.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import { type Message, createToolMessage } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { compressShellOutput } from '../../utils/shell-compress.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export interface ToolExecutorConfig {
	tools: ToolRegistry
	runId: RunId
	workingDirectory: string
	permissionMode: PermissionMode
	env: Record<string, string>
	abortSignal: AbortSignal
}

export interface ToolExecutionBatch {
	messages: Message[]
	results: Array<{ toolCallId: string; output: string }>
}

export class ToolExecutor {
	private config: ToolExecutorConfig
	private activityStore: ActivityStore
	private emitEvent: EmitEvent
	private log: Logger
	private workingStateManager?: WorkingStateManager

	constructor(
		config: ToolExecutorConfig,
		activityStore: ActivityStore,
		emitEvent: EmitEvent,
		log: Logger,
	) {
		this.config = config
		this.activityStore = activityStore
		this.emitEvent = emitEvent
		this.log = log
	}

	setWorkingStateManager(manager: WorkingStateManager): void {
		this.workingStateManager = manager
	}

	async executeBatch(response: ChatCompletionResponse): Promise<ToolExecutionBatch> {
		const toolCalls = response.message.toolCalls
		if (!toolCalls) {
			return { messages: [], results: [] }
		}

		this.log.debug('Executing tool batch', {
			runId: this.config.runId,
			toolCount: toolCalls.length,
			tools: toolCalls.map((tc) => tc.function.name),
		})

		const toolContext = this.buildToolContext()

		const results = await Promise.all(
			toolCalls.map((toolCall) => this.executeSingle(toolCall, toolContext)),
		)

		const messages: Message[] = results.map((r) => createToolMessage(r.output, r.toolCallId))

		return { messages, results }
	}

	private buildToolContext(): ToolContext {
		return {
			runId: this.config.runId,
			workingDirectory: this.config.workingDirectory,
			abortSignal: this.config.abortSignal,
			env: this.config.env,
			log: (level, message) => this.log[level](message),
			permissionContext: {
				mode: this.config.permissionMode,
				sessionId: this.config.runId,
				workingDirectory: this.config.workingDirectory,
			},
			toolRegistry: this.config.tools,
		}
	}

	private async executeSingle(
		toolCall: {
			id: string
			type: string
			function: { name: string; arguments: string }
		},
		toolContext: ToolContext,
	): Promise<{ toolCallId: string; output: string }> {
		const toolName = toolCall.function.name
		let input: unknown

		try {
			input = JSON.parse(toolCall.function.arguments)
		} catch {
			return {
				toolCallId: toolCall.id,
				output: `Error: Invalid JSON in tool arguments for "${toolName}"`,
			}
		}

		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId: toolCall.id,
		})
		if (activity) {
			this.activityStore.start(activity.id)
		}

		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolName,
			input,
		})

		if (this.workingStateManager) {
			extractFromToolCall(this.workingStateManager, toolName, toolCall.function.arguments)
		}

		const startMs = Date.now()
		const result = await this.config.tools.execute(toolName, input, toolContext)
		const durationMs = Date.now() - startMs

		const rawOutput = result.success
			? result.output
			: `Error: ${result.error ?? 'Tool execution failed'}`

		const output = result.success ? this.maybeCompress(toolName, rawOutput) : rawOutput

		if (this.workingStateManager) {
			extractFromToolResult(this.workingStateManager, toolName, output, !result.success)
		}

		if (result.success) {
			this.log.debug('Tool executed successfully', {
				runId: this.config.runId,
				tool: toolName,
				durationMs,
				outputLength: output.length,
			})
		} else {
			this.log.warn('Tool execution failed', {
				runId: this.config.runId,
				tool: toolName,
				durationMs,
				error: result.error ?? 'unknown',
			})
		}

		if (activity) {
			if (result.success) {
				this.activityStore.complete(activity.id, output)
			} else {
				this.activityStore.fail(activity.id, result.error ?? 'Tool execution failed')
			}
		}

		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolName,
			result: output,
		})

		return { toolCallId: toolCall.id, output }
	}

	private maybeCompress(toolName: string, output: string): string {
		const tool = this.config.tools.get(toolName)
		if (!tool || tool.category !== 'shell') {
			return output
		}

		const compressed = compressShellOutput(output)
		if (compressed.length < output.length) {
			this.log.debug('Shell output compressed', {
				tool: toolName,
				originalLength: output.length,
				compressedLength: compressed.length,
				reductionPercent: Math.round((1 - compressed.length / output.length) * 100),
			})
		}
		return compressed
	}
}
