import { extractFromToolCall, extractFromToolResult } from '../../compaction/extractor.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { buildProbeContext } from '../../probe/context.js'
import { ProbeVetoError } from '../../probe/errors.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import { type Message, type ToolCall, createToolMessage } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import type {
	FileReadTracker,
	ToolContext,
	ToolRegistryContract,
	ToolResult,
} from '../../types/tool/index.js'
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
	allowedTools?: readonly string[]
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

/**
 * Denial reasons keyed by `tool_use` id. Any id present here is answered
 * with a synthetic `tool_result` carrying the reason INSTEAD of being
 * executed — see {@link ToolExecutor.executeBatch}.
 */
export type ToolCallDenials = ReadonlyMap<string, string>

/**
 * Model-visible text for a tool call that was never executed.
 *
 * The reason travels INSIDE the `tool_result` rather than as a trailing
 * user message: a `tool_use` block must be answered by a `tool_result`
 * with the same id, and a denial is an answer, not an omission. Putting
 * the reason here is also what makes rejection *steer* — the model reads
 * it in the slot it already attends to for tool outcomes.
 */
export function deniedToolOutput(toolName: string, reason: string): string {
	return `Error: Tool "${toolName}" was not executed. ${reason}`
}

export class ToolExecutor {
	private config: ToolExecutorConfig
	private activityStore: ActivityStore
	private emitEvent: EmitEvent
	private log: Logger
	private workingStateManager?: WorkingStateManager
	private probes: ProbeRegistry
	private readonly readPaths: Set<string> = new Set()
	private readonly fileReadTracker: FileReadTracker = {
		recordRead: (key: string) => {
			this.readPaths.add(key)
		},
		hasRead: (key: string) => this.readPaths.has(key),
	}

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

	/**
	 * Answer every `tool_use` block in `response` with exactly one
	 * `tool_result`.
	 *
	 * `denials` marks ids that must NOT run: each is answered with a
	 * synthetic error result carrying the caller's reason instead of being
	 * executed. This is what makes the invariant hold by construction —
	 * a gate denial, a human rejection and a partial approval all leave
	 * the history valid, because there is exactly one place that turns a
	 * batch of tool calls into messages and it always covers all of them.
	 *
	 * Answering with `is_error` semantics rather than dropping the call is
	 * the universal contract across providers: an unanswered `tool_use`
	 * is a protocol violation, not a decline.
	 */
	async executeBatch(
		response: ChatCompletionResponse,
		denials?: ToolCallDenials,
	): Promise<ToolExecutionBatch> {
		const toolCalls = response.message.toolCalls
		if (!toolCalls) {
			return { messages: [], results: [] }
		}

		this.log.debug('Executing tool batch', {
			runId: this.config.runId,
			toolCount: toolCalls.length,
			deniedCount: denials?.size ?? 0,
			tools: toolCalls.map((tc) => tc.function.name),
		})

		// One context per call so each execution can see its own
		// `toolUseId`. The base context is built once; we spread + add
		// per-call to keep allocations cheap.
		const baseContext = this.buildToolContext()

		// Respect each tool's `concurrencySafe` flag. Read-only tools
		// (ls/grep/glob/…) run in parallel; tools that mutate shared state
		// (edit/write/append/bash — `concurrencySafe: false`) are serialized in
		// a single chain, so e.g. several `edit` calls to the SAME file in one
		// turn apply one-after-another instead of racing read→modify→write
		// (which let the last writer clobber the rest). Results are written by
		// index to preserve the original tool-call order.
		const results: Array<{ toolCallId: string; output: string }> = new Array(toolCalls.length)
		const parallel: Promise<void>[] = []
		let serial: Promise<void> = Promise.resolve()
		toolCalls.forEach((toolCall, i) => {
			const denialReason = denials?.get(toolCall.id)
			if (denialReason !== undefined) {
				// Denied calls never touch the tool; they still get a result
				// message so the assistant turn stays fully answered. Run them
				// on the parallel branch — they perform no side effects, so
				// serialization would only add latency.
				parallel.push(
					this.recordDenial(toolCall, denialReason).then((r) => {
						results[i] = r
					}),
				)
				return
			}
			const ctx = { ...baseContext, toolUseId: toolCall.id }
			const run = async () => {
				results[i] = await this.executeSingle(toolCall, ctx)
			}
			let input: unknown = {}
			try {
				input = JSON.parse(toolCall.function.arguments || '{}')
			} catch {
				// non-JSON args → treat as unsafe (serialize), the conservative path
			}
			const safe =
				this.config.tools.get(toolCall.function.name)?.isConcurrencySafe?.(input) === true
			if (safe) parallel.push(run())
			else serial = serial.then(run)
		})
		await Promise.all([...parallel, serial])

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
			allowedTools: this.config.allowedTools,
			sandbox: this.config.sandbox,
			fileReadTracker: this.fileReadTracker,
		}
	}

	private async executeSingle(
		toolCall: ToolCall,
		toolContext: ToolContext,
	): Promise<{ toolCallId: string; output: string }> {
		const toolName = toolCall.function.name

		if (toolCall.metadata?.inputTruncated === true) {
			const message = truncatedToolInputMessage(toolName)
			await this.emitEvent({
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				input: {},
			})
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: message,
				isError: true,
			})
			return { toolCallId: toolCall.id, output: message }
		}

		let input: unknown

		try {
			input = JSON.parse(toolCall.function.arguments)
		} catch {
			// Codex M2: malformed JSON args used to return without ever
			// emitting tool_executing or tool_completed, leaving UI cards
			// orphaned in `streaming_input`. Emit the executing→completed
			// terminal pair so the card lifecycle closes.
			const message = `Error: Invalid JSON in tool arguments for "${toolName}"`
			await this.emitEvent({
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				input: {},
			})
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: message,
				isError: true,
			})
			return { toolCallId: toolCall.id, output: message }
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
			toolUseId: toolCall.id,
			toolName,
			input,
		})

		const vetoOutcome = this.probes.queryVeto(
			{
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: toolCall.id,
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
			// Codex M1: probe veto used to skip tool_completed entirely.
			// Emit the terminal event with isError so UI cards finalize.
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: `Error: ${veto.message}`,
				isError: true,
			})
			return {
				toolCallId: toolCall.id,
				output: `Error: ${veto.message}`,
			}
		}

		if (this.workingStateManager) {
			extractFromToolCall(this.workingStateManager, toolName, JSON.stringify(input))
		}

		const startMs = Date.now()
		// Codex M4: an unhandled throw from `tools.execute(...)` used to
		// propagate up to `result.ts` as `run_failed` without emitting a
		// terminal `tool_completed`, leaving UI cards stuck in `executing`.
		// Wrap so any throw materialises as an error result.
		let result: { success: boolean; output: string; error?: string }
		try {
			result = await this.config.tools.execute(toolName, input, toolContext)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			this.log.warn('Tool execution threw', {
				runId: this.config.runId,
				tool: toolName,
				error: message,
			})
			result = { success: false, output: '', error: message }
		}
		const durationMs = Date.now() - startMs

		const rawOutput = result.success
			? result.output
			: formatFailedToolOutput(result.output, result.error)

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
			toolUseId: toolCall.id,
			toolName,
			result: output,
			isError: effectiveIsError,
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

	/**
	 * Answer a tool call that policy or a human refused, without executing
	 * it. Emits the same `tool_executing` → `tool_completed` pair as a real
	 * execution so UI cards reach a terminal state instead of hanging in
	 * `executing`, and records a failed activity for the trace.
	 */
	private async recordDenial(
		toolCall: ToolCall,
		reason: string,
	): Promise<{ toolCallId: string; output: string }> {
		const toolName = toolCall.function.name
		let input: unknown = {}
		try {
			input = JSON.parse(toolCall.function.arguments || '{}')
		} catch {
			input = toolCall.function.arguments
		}

		const output = deniedToolOutput(toolName, reason)

		this.log.info('Tool call denied — synthesizing tool_result', {
			runId: this.config.runId,
			tool: toolName,
			toolUseId: toolCall.id,
			reason,
		})

		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId: toolCall.id,
		})
		if (activity) {
			this.activityStore.start(activity.id)
			this.activityStore.fail(activity.id, output)
		}

		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			input,
		})
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			result: output,
			isError: true,
		})

		return { toolCallId: toolCall.id, output }
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
			toolUseId: toolCallId,
			toolName,
			input,
		})
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: toolCallId,
			toolName,
			result: outcome.output,
			isError: outcome.kind === 'error',
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

function formatFailedToolOutput(output: string | undefined, error: string | undefined): string {
	const errorText = `Error: ${error ?? 'Tool execution failed'}`
	if (!output || output.trim().length === 0) return errorText
	return `${output}\n\n${errorText}`
}

function truncatedToolInputMessage(toolName: string): string {
	return `Error: Tool "${toolName}" call was cut off while the model was streaming JSON arguments. The tool was NOT executed. Retry with a much shorter input. Self-budget any content/newStr payload under 12000 characters before calling file tools. For long files, create a short opening with write, then extend it with edit using insertLine: "end" in bounded section chunks; for delegated work, pass a shared workspace filename/reference instead of embedding the content in the tool call.`
}
