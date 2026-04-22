import { extractFromToolCall, extractFromToolResult } from '../../compaction/extractor.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { buildProbeContext } from '../../probe/context.js'
import { ProbeVetoError } from '../../probe/errors.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import { type Message, createToolMessage } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import type { ToolContext, ToolRegistryContract, ToolResult } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { compressShellOutput } from '../../utils/shell-compress.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export interface ToolExecutorConfig {
	tools: ToolRegistryContract
	runId: RunId
	workingDirectory: string
	permissionMode: PermissionMode
	env: Record<string, string>
	abortSignal: AbortSignal
	sandbox?: Sandbox
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
}

type PreToolHookOutcome =
	| { kind: 'continue'; input: unknown }
	| { kind: 'skip'; input: unknown; output: string }
	| { kind: 'error'; input: unknown; output: string }

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
	private probes: ProbeRegistry

	constructor(
		config: ToolExecutorConfig,
		activityStore: ActivityStore,
		emitEvent: EmitEvent,
		log: Logger,
		probes: ProbeRegistry = defaultProbeRegistry,
	) {
		this.config = config
		this.activityStore = activityStore
		this.emitEvent = emitEvent
		this.log = log
		this.probes = probes
	}

	setWorkingStateManager(manager: WorkingStateManager): void {
		this.workingStateManager = manager
	}

	setSandbox(sandbox: Sandbox): void {
		this.config = { ...this.config, sandbox }
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
				runId: this.config.runId,
				workingDirectory: this.config.workingDirectory,
			},
			invocationState: this.config.invocationState,
			toolRegistry: this.config.tools,
			sandbox: this.config.sandbox,
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

		const preOutcome = await this.runPreToolHook(toolName, input)
		if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
			return this.recordSyntheticHookOutcome(toolCall.id, toolName, preOutcome.input, preOutcome)
		}
		input = preOutcome.input

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

		const vetoOutcome = this.probes.queryVeto(
			{
				type: 'tool_executing',
				runId: this.config.runId,
				toolName,
				input,
			},
			buildProbeContext({ runId: this.config.runId }),
		)
		if (vetoOutcome.action === 'deny') {
			const probeName = vetoOutcome.probeName ?? 'unnamed'
			const reason = vetoOutcome.reason ?? 'no reason provided'
			const veto = new ProbeVetoError(probeName, reason, 'tool_executing')
			this.log.warn('Tool call denied by probe', {
				runId: this.config.runId,
				tool: toolName,
				probeName,
				reason,
			})
			if (activity) {
				this.activityStore.fail(activity.id, veto.message)
			}
			return {
				toolCallId: toolCall.id,
				output: `Error: ${veto.message}`,
			}
		}

		if (this.workingStateManager) {
			extractFromToolCall(this.workingStateManager, toolName, JSON.stringify(input))
		}

		const startMs = Date.now()
		const result = await this.config.tools.execute(toolName, input, toolContext)
		const durationMs = Date.now() - startMs

		const rawOutput = result.success
			? result.output
			: `Error: ${result.error ?? 'Tool execution failed'}`

		let output = result.success ? this.maybeCompress(toolName, rawOutput) : rawOutput

		const postOverride = await this.runPostToolHook(toolName, input, result)
		if (postOverride !== null) {
			output = postOverride
		}

		const effectiveIsError = !result.success || postOverride !== null

		if (this.workingStateManager) {
			extractFromToolResult(this.workingStateManager, toolName, output, effectiveIsError)
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
			if (effectiveIsError) {
				this.activityStore.fail(activity.id, output)
			} else {
				this.activityStore.complete(activity.id, output)
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

	private async runPreToolHook(toolName: string, input: unknown): Promise<PreToolHookOutcome> {
		if (!this.config.pluginManager) return { kind: 'continue', input }
		const results = await this.config.pluginManager.executeHooks(
			'pre_tool_use',
			{ runId: this.config.runId, toolName, toolInput: input },
			this.emitEvent,
		)
		return this.interpretPreToolResults(toolName, input, results)
	}

	private interpretPreToolResults(
		toolName: string,
		initialInput: unknown,
		results: readonly PluginHookResult[],
	): PreToolHookOutcome {
		let currentInput = initialInput
		for (const result of results) {
			switch (result.action) {
				case 'continue':
					continue
				case 'modify':
					currentInput = result.input
					continue
				case 'skip':
					return {
						kind: 'skip',
						input: currentInput,
						output: `Tool ${toolName} skipped by plugin: ${result.reason}`,
					}
				case 'error':
					return {
						kind: 'error',
						input: currentInput,
						output: `Error: ${result.message}`,
					}
				case 'retry':
				case 'resume':
					throw new Error(
						`Plugin hook pre_tool_use returned unsupported action '${result.action}' for tool ${toolName}`,
					)
				default: {
					const _exhaustive: never = result
					throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
				}
			}
		}
		return { kind: 'continue', input: currentInput }
	}

	private async runPostToolHook(
		toolName: string,
		input: unknown,
		toolResult: ToolResult,
	): Promise<string | null> {
		if (!this.config.pluginManager) return null
		const results = await this.config.pluginManager.executeHooks(
			'post_tool_use',
			{ runId: this.config.runId, toolName, toolInput: input, toolResult },
			this.emitEvent,
		)
		let override: string | null = null
		for (const result of results) {
			switch (result.action) {
				case 'continue':
					continue
				case 'error':
					override = `Error: ${result.message}`
					continue
				case 'skip':
				case 'modify':
				case 'retry':
				case 'resume':
					throw new Error(
						`Plugin hook post_tool_use returned unsupported action '${result.action}' for tool ${toolName}`,
					)
				default: {
					const _exhaustive: never = result
					throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
				}
			}
		}
		return override
	}

	private async recordSyntheticHookOutcome(
		toolCallId: string,
		toolName: string,
		input: unknown,
		outcome: { kind: 'skip' | 'error'; output: string },
	): Promise<{ toolCallId: string; output: string }> {
		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId,
		})
		if (activity) {
			this.activityStore.start(activity.id)
			if (outcome.kind === 'skip') {
				this.activityStore.complete(activity.id, outcome.output)
			} else {
				this.activityStore.fail(activity.id, outcome.output)
			}
		}
		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolName,
			input,
		})
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolName,
			result: outcome.output,
		})
		return { toolCallId, output: outcome.output }
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
