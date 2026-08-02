import type { Span } from '@opentelemetry/api'
import { extractFromToolCall, extractFromToolResult } from '../../compaction/extractor.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { buildProbeContext } from '../../probe/context.js'
import { ProbeVetoError } from '../../probe/errors.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../../probe/registry.js'
import { renderToolSchema } from '../../registry/tool/schema.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import type { RunId, ToolUseId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import {
	type Message,
	type ToolCall,
	type ToolResultContent,
	createToolMessage,
} from '../../types/message/index.js'
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
import type {
	RepairToolCall,
	ToolCallRepair,
	ToolCallRepairReason,
} from '../../types/tool/repair.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import { compressShellOutput } from '../../utils/shell-compress.js'
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, applyToolOutputBudget } from './tool-output-budget.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

/**
 * Default per-tool deadline. Long enough for a real build or test run,
 * short enough that a wedged tool does not hold a turn open indefinitely.
 * A tool that legitimately runs longer declares its own `timeoutMs`.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000

/**
 * Cap on tools executing at once within a single batch.
 *
 * `executeBatch` used to `Promise.all` an unbounded fan-out, so a model
 * emitting fifty parallel reads opened fifty file handles and fifty
 * activity records at once. The serial chain is unaffected — it is
 * already one-at-a-time by construction.
 */
export const DEFAULT_TOOL_CONCURRENCY = 8

/**
 * Re-runs granted to a `post_tool_use` hook that returns `{action:'retry'}`
 * on a tool which did not opt into {@link ToolDefinition.maxRetries}.
 *
 * Small on purpose. The hook is host code reacting to one specific result,
 * which is a more specific signal than the tool's blanket idempotency
 * declaration — but the tool still never said it was safe to re-run, so
 * this buys one correction, not a loop.
 */
export const HOOK_RETRY_BUDGET = 1

/**
 * An empty arguments string means "no arguments", not "malformed" — the
 * shape a no-parameter tool arrives in.
 */
function parseArguments(raw: string): unknown {
	return JSON.parse(raw || '{}')
}

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
	/** Run-level default deadline; per-tool `timeoutMs` overrides it. */
	toolTimeoutMs?: number
	/** Max concurrently-executing concurrency-safe tools. */
	maxToolConcurrency?: number
	/**
	 * Model-visible size cap for a single tool result. Defaults to
	 * {@link DEFAULT_MAX_TOOL_OUTPUT_CHARS}; set `0` to disable.
	 */
	maxToolOutputChars?: number
	/**
	 * Where over-budget output is spilled so the model can read it back
	 * with `read`/`grep`. Absent ⇒ over-budget output is middle-elided and
	 * the overflow is lost.
	 */
	toolOutputDir?: string
	/**
	 * Last chance to fix a tool call the model got wrong, before the error
	 * reaches it. See {@link RepairToolCall}.
	 */
	repairToolCall?: RepairToolCall
}

type PreToolHookOutcome =
	| { kind: 'continue'; input: unknown }
	| { kind: 'skip'; input: unknown; output: string }
	| { kind: 'error'; input: unknown; output: string }

/** What one tool call produced, before it becomes a message. */
export interface ToolCallOutcome {
	toolCallId: string
	/** Which tool produced it. */
	toolName: string
	/** Text form — what the host, the transcript and compaction see. */
	output: string
	/** Rich form for the model, when the tool supplied one. */
	content?: ToolResultContent
	isError?: boolean
}

export interface ToolExecutionBatch {
	messages: Message[]
	results: ToolCallOutcome[]
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
	private parentSpan?: Span
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
	 * Span that this executor's tool spans should hang off — the current
	 * iteration. Re-set each turn by the orchestrator, because a tool span
	 * belongs under the iteration that requested it.
	 */
	setParentSpan(span: Span | undefined): void {
		this.parentSpan = span
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
		const results: ToolCallOutcome[] = new Array(toolCalls.length)
		const parallel: Promise<void>[] = []
		let serial: Promise<void> = Promise.resolve()
		// Bounded fan-out. A model emitting fifty parallel reads used to open
		// fifty file handles and fifty activity records simultaneously; the
		// gate keeps that at a working-set size while preserving completion
		// order independence.
		const gate = new Semaphore(this.config.maxToolConcurrency ?? DEFAULT_TOOL_CONCURRENCY)
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
			// Per-call, because the event has to name which call it is about:
			// a batch can run several tools at once and a host rendering them
			// side by side needs to know whose progress this is.
			const ctx: ToolContext = {
				...baseContext,
				toolUseId: toolCall.id,
				report: (message: string, fraction?: number) => {
					// Fire-and-forget: a tool reporting progress must never be
					// able to fail because the host's listener threw, and must
					// never have to await the emit mid-work.
					void this.emitEvent({
						type: 'tool_progress',
						runId: this.config.runId,
						toolUseId: toolCall.id as ToolUseId,
						toolName: toolCall.function.name,
						message,
						...(fraction !== undefined ? { fraction: Math.min(1, Math.max(0, fraction)) } : {}),
					}).catch(() => {})
				},
			}
			const run = async () => {
				results[i] = await this.executeSingle(toolCall, ctx)
			}
			const gated = async () => {
				await gate.acquire()
				try {
					await run()
				} finally {
					gate.release()
				}
			}
			let input: unknown = {}
			try {
				input = JSON.parse(toolCall.function.arguments || '{}')
			} catch {
				// non-JSON args → treat as unsafe (serialize), the conservative path
			}
			const safe =
				this.config.tools.get(toolCall.function.name)?.isConcurrencySafe?.(input) === true
			if (safe) parallel.push(gated())
			else serial = serial.then(run)
		})
		await Promise.all([...parallel, serial])

		// Whatever failed above left a hole in `results`; fill every one, so
		// the invariant holds by construction rather than by everything having
		// gone well.
		for (let i = 0; i < toolCalls.length; i++) {
			if (results[i]) continue
			const toolCall = toolCalls[i] as ToolCall
			const toolName = toolCall.function.name
			const message = `Error: Tool "${toolName}" did not complete — the batch failed before it produced a result.`
			results[i] = { toolCallId: toolCall.id, toolName, output: message, isError: true }
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: message,
				isError: true,
			})
		}

		// isError and rich content were computed and then discarded here: the
		// tuple narrowed to {toolCallId, output} BEFORE the message was built,
		// so the failure signal and any image block were structurally lost at
		// the last possible moment.
		const messages: Message[] = results.map((r) =>
			createToolMessage(r.content ?? r.output, r.toolCallId, r.isError),
		)

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
			...(this.parentSpan ? { parentSpan: this.parentSpan } : {}),
		}
	}

	private async executeSingle(
		toolCall: ToolCall,
		toolContext: ToolContext,
	): Promise<ToolCallOutcome> {
		let toolName = toolCall.function.name

		// A stream that cut off mid-JSON is the case `repairToolCall` exists
		// for, and it used to be the one case that never reached it: this
		// branch returned before `resolveCall` ran, so the motivating failure
		// was answered with a generic hint while the configured repairer sat
		// unused. Offer it the partial buffer first.
		const truncationRepair =
			toolCall.metadata?.inputTruncated === true
				? await this.repairTruncatedCall(toolCall, toolName)
				: null

		if (toolCall.metadata?.inputTruncated === true && !truncationRepair) {
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
			return { toolCallId: toolCall.id, toolName, output: message, isError: true }
		}

		// A malformed call used to cost a full model round trip to fix: the
		// error went back as a `tool_result`, the model re-read the whole
		// context and tried again. A host that can repair it locally turns
		// that into nothing. No-op when no repairer is configured.
		const resolved = await this.resolveCall(
			truncationRepair
				? {
						...toolCall,
						function: {
							...toolCall.function,
							name: truncationRepair.toolName ?? toolName,
							arguments: truncationRepair.arguments,
						},
						metadata: {},
					}
				: toolCall,
		)
		toolName = resolved.toolName

		if (!resolved.ok) {
			// malformed JSON args used to return without ever
			// emitting tool_executing or tool_completed, leaving UI cards
			// orphaned in `streaming_input`. Emit the executing→completed
			// terminal pair so the card lifecycle closes.
			const message = resolved.message
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
			return { toolCallId: toolCall.id, toolName, output: message, isError: true }
		}

		let input: unknown = resolved.input

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
			// probe veto used to skip tool_completed entirely.
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
				toolName,
				output: `Error: ${veto.message}`,
			}
		}

		if (this.workingStateManager) {
			extractFromToolCall(this.workingStateManager, toolName, JSON.stringify(input))
		}

		const startMs = Date.now()
		// an unhandled throw from `tools.execute(...)` used to
		// propagate up to `result.ts` as `run_failed` without emitting a
		// terminal `tool_completed`, leaving UI cards stuck in `executing`.
		// Wrap so any throw materialises as an error result.
		// Typed as the full ToolResult, not a narrowed literal: the narrow
		// version silently DROPPED `content`, so a tool returning an image
		// block had it discarded here — before the wire mapper that was
		// built to carry it ever saw it.
		let result: ToolResult = await this.runOnce(toolName, input, toolContext)
		let post = await this.runPostToolHook(toolName, input, result)

		// In-loop retry. A transient failure used to cost a full model round
		// trip: the error went back as a `tool_result`, the model read it and
		// decided (or didn't) to call again. Strictly opt-in per tool,
		// because the SDK cannot know a tool is idempotent — silently
		// re-running a write or a payment is worse than never retrying.
		const maxRetries = Math.max(0, this.config.tools.get(toolName)?.maxRetries ?? 0)
		for (let attempt = 1; ; attempt++) {
			// A missing file will not appear on the second attempt; burning
			// the budget on it only delays the error the model needs to see.
			const toolWants = !result.success && result.retryable === true
			// A `post_tool_use` hook asking for a retry gets its OWN budget.
			// Bounding it by `maxRetries` made it a silent no-op at the
			// shipped default of 0: the hook's answer was read and discarded
			// on every tool that had not separately opted in. The hook is
			// host code looking at this specific result — a more specific
			// signal than the tool's blanket idempotency declaration — so it
			// is honored, but still bounded so a plugin cannot spin the
			// executor.
			if (!toolWants && !post.retry) break
			const budget = post.retry ? Math.max(maxRetries, HOOK_RETRY_BUDGET) : maxRetries
			if (attempt > budget) break

			this.log.info('Retrying a failed tool call', {
				runId: this.config.runId,
				tool: toolName,
				attempt,
				budget,
				requestedByHook: post.retry,
				error: result.error,
			})
			result = await this.runOnce(toolName, input, toolContext)
			post = await this.runPostToolHook(toolName, input, result)
		}
		const durationMs = Date.now() - startMs

		const rawOutput = result.success
			? result.output
			: formatFailedToolOutput(result.output, result.error)

		let output = result.success ? this.maybeCompress(toolName, rawOutput) : rawOutput

		// Compression is opportunistic and shell-only; the budget is the
		// hard bound that applies to every tool. Runs after compression so
		// a result that shrinks under the cap is never spilled needlessly.
		const budgeted = applyToolOutputBudget({
			toolName,
			toolUseId: toolCall.id,
			output,
			maxChars: this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
			spillDir: this.config.toolOutputDir,
			onError: (message) =>
				this.log.warn('Failed to spill oversized tool output', {
					runId: this.config.runId,
					tool: toolName,
					error: message,
				}),
		})
		if (budgeted.truncated) {
			this.log.warn('Tool output exceeded the model-visible budget', {
				runId: this.config.runId,
				tool: toolName,
				originalLength: budgeted.originalLength,
				spillPath: budgeted.spillPath,
			})
		}
		output = budgeted.output

		const postOverride = post.override
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
			durationMs,
			// Pre-truncation size, so a host can show "returned 2.1 MB" even
			// though the model only ever saw a preview.
			outputLength: budgeted.originalLength,
			...(budgeted.truncated ? { outputTruncated: true } : {}),
			...(budgeted.spillPath ? { outputSpillPath: budgeted.spillPath } : {}),
		})

		return {
			toolCallId: toolCall.id,
			toolName,
			output,
			isError: effectiveIsError,
			// A plugin override replaces what the model sees, and a spilled
			// preview is no longer the tool's own payload — neither may carry
			// rich content through.
			...(result.content !== undefined && postOverride === null && !budgeted.truncated
				? { content: result.content }
				: {}),
		}
	}

	/**
	 * Run a tool under a deadline, with the run abort folded in.
	 *
	 * `ToolContext.abortSignal` existed but was produced and consumed by
	 * nothing: a Stop tore down the model stream and then parked inside
	 * `Promise.all` waiting for a tool that had no idea it should quit. A
	 * hung MCP stdio server or a `bash` with the old one-hour default
	 * could hold a turn open long after the user cancelled.
	 *
	 * Two mechanisms, because neither alone is enough:
	 *
	 * 1. The composed signal (run abort OR deadline) is handed to the tool
	 *    so a cooperative tool actually stops working.
	 * 2. The `race` bounds the *executor's* wait regardless, so an
	 *    uncooperative tool becomes detached rather than blocking.
	 *
	 * A timeout is reported as a normal failed result, not a throw: the
	 * model sees "this timed out" as a `tool_result` and can route around
	 * it, which is what Pydantic AI and the OpenAI Agents SDK both do.
	 */
	private async executeWithDeadline(
		toolName: string,
		input: unknown,
		toolContext: ToolContext,
	): Promise<ToolResult> {
		const timeoutMs =
			this.config.tools.get(toolName)?.timeoutMs ??
			this.config.toolTimeoutMs ??
			DEFAULT_TOOL_TIMEOUT_MS

		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			return this.config.tools.execute(toolName, input, toolContext)
		}

		const controller = new AbortController()
		const runSignal = this.config.abortSignal
		const onRunAbort = () => controller.abort(runSignal.reason)
		if (runSignal.aborted) controller.abort(runSignal.reason)
		else runSignal.addEventListener('abort', onRunAbort, { once: true })

		let timer: ReturnType<typeof setTimeout> | undefined
		let timedOut = false

		try {
			const expired = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true
					controller.abort(new Error(`Tool "${toolName}" exceeded ${timeoutMs}ms`))
					resolve('timeout')
				}, timeoutMs)
			})

			const aborted = new Promise<'aborted'>((resolve) => {
				if (controller.signal.aborted && !timedOut) {
					resolve('aborted')
					return
				}
				controller.signal.addEventListener(
					'abort',
					() => {
						if (!timedOut) resolve('aborted')
					},
					{ once: true },
				)
			})

			const execution = this.config.tools.execute(toolName, input, {
				...toolContext,
				abortSignal: controller.signal,
			})
			// The loser of the race may still reject later; neutralize it so
			// it is never an unhandled rejection.
			execution.catch(() => {})

			const outcome = await Promise.race([execution, expired, aborted])

			if (outcome === 'timeout') {
				this.log.warn('Tool timed out', {
					runId: this.config.runId,
					tool: toolName,
					timeoutMs,
				})
				return {
					success: false,
					output: '',
					error: `Tool "${toolName}" timed out after ${timeoutMs}ms and was abandoned. It may still be running. Try a narrower input, or a different approach.`,
				}
			}

			if (outcome === 'aborted') {
				return {
					success: false,
					output: '',
					error: `Tool "${toolName}" was cancelled.`,
				}
			}

			return outcome
		} finally {
			if (timer !== undefined) clearTimeout(timer)
			runSignal.removeEventListener('abort', onRunAbort)
		}
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

	/**
	 * Turn the call the model issued into a name and a parsed input, giving
	 * a configured repairer one chance to fix it first.
	 *
	 * Exactly one chance: a repairer that produces a call which is still
	 * broken will not do better on a second look, and an unbounded loop
	 * here is a hang rather than a degradation.
	 *
	 * `invalid_json` is the ONLY failure that stops the call here, and it
	 * stopped it before this function existed too. `unknown_tool` and
	 * `schema_validation` merely OFFER the repair and otherwise fall
	 * through to the registry, which reports both with better messages —
	 * its schema error already ships a "Required: <field>: <type>" hint the
	 * model can self-correct from. So with no repairer configured this is
	 * behaviorally identical to the bare `JSON.parse` it replaced.
	 */
	private async resolveCall(
		toolCall: ToolCall,
	): Promise<
		| { ok: true; toolName: string; input: unknown }
		| { ok: false; toolName: string; message: string }
	> {
		let toolName = toolCall.function.name
		let raw = toolCall.function.arguments

		for (let attempt = 0; ; attempt++) {
			const failure = this.inspectCall(toolName, raw)
			if (!failure) return { ok: true, toolName, input: parseArguments(raw) }

			const repair =
				attempt === 0 && this.config.repairToolCall
					? await this.requestRepair(toolCall, toolName, failure)
					: null

			if (!repair) {
				if (failure.reason === 'invalid_json') {
					return { ok: false, toolName, message: failure.message }
				}
				return { ok: true, toolName, input: parseArguments(raw) }
			}

			this.log.info('Repaired a malformed tool call', {
				runId: this.config.runId,
				tool: toolName,
				reason: failure.reason,
				...(repair.toolName && repair.toolName !== toolName ? { repairedTo: repair.toolName } : {}),
			})
			toolName = repair.toolName ?? toolName
			raw = repair.arguments
		}
	}

	/**
	 * What is wrong with this call, or `null` if nothing is.
	 *
	 * JSON is checked before the tool is looked up: an unparseable argument
	 * string is broken regardless of which tool it was aimed at, and it is
	 * the one problem the executor itself has to answer.
	 */
	private async repairTruncatedCall(
		toolCall: ToolCall,
		toolName: string,
	): Promise<ToolCallRepair | null> {
		if (!this.config.repairToolCall) return null

		// Present the PARTIAL buffer, not the normalized `"{}"` — a repairer
		// handed an empty object has nothing to work from.
		const partial = toolCall.metadata?.partialArguments ?? ''
		const repair = await this.requestRepair(
			{ ...toolCall, function: { ...toolCall.function, arguments: partial } },
			toolName,
			{ reason: 'invalid_json', message: truncatedToolInputMessage(toolName) },
		)
		if (repair) {
			this.log.info('Repaired a tool call whose input stream was truncated', {
				runId: this.config.runId,
				tool: toolName,
				partialLength: partial.length,
			})
		}
		return repair
	}

	private inspectCall(
		toolName: string,
		raw: string,
	): { reason: ToolCallRepairReason; message: string } | null {
		let parsed: unknown
		try {
			parsed = parseArguments(raw)
		} catch {
			return {
				reason: 'invalid_json',
				message: `Error: Invalid JSON in tool arguments for "${toolName}"`,
			}
		}

		const tool = this.config.tools.get?.(toolName)
		if (!tool) {
			// Either the model named a tool that does not exist, or this
			// registry does not implement `get`. Both are the registry's to
			// answer; a repairer still gets offered the `unknown_tool` case.
			return { reason: 'unknown_tool', message: `Error: Unknown tool "${toolName}"` }
		}

		// A registry that hands back a tool with no schema has nothing to
		// validate against; that is not a repairable condition, just an
		// unvalidatable one.
		const validation = tool.inputSchema?.safeParse(parsed)
		if (validation && !validation.success) {
			return {
				reason: 'schema_validation',
				message: `Error: Invalid arguments for "${toolName}": ${validation.error.issues
					.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
					.join('; ')}`,
			}
		}

		return null
	}

	private async requestRepair(
		toolCall: ToolCall,
		toolName: string,
		failure: { reason: ToolCallRepairReason; message: string },
	): Promise<ToolCallRepair | null> {
		const repairToolCall = this.config.repairToolCall
		if (!repairToolCall) return null

		const tool = this.config.tools.get(toolName)
		try {
			return await repairToolCall({
				toolCall,
				reason: failure.reason,
				message: failure.message,
				...(tool ? { tool, jsonSchema: renderToolSchema(tool.inputSchema) } : {}),
				availableTools: this.config.tools.listNames(),
			})
		} catch (err) {
			// A broken repairer must not turn a recoverable tool error into a
			// failed run: the original error is still a perfectly good answer
			// to give the model.
			this.log.error('repairToolCall threw — falling back to the original error', {
				runId: this.config.runId,
				tool: toolName,
				error: toErrorMessage(err),
			})
			return null
		}
	}

	/**
	 * One execution attempt, with a throw materialized as an error result.
	 *
	 * an unhandled throw from `tools.execute(...)` used to
	 * propagate up to `result.ts` as `run_failed` without emitting a
	 * terminal `tool_completed`, leaving UI cards stuck in `executing`.
	 *
	 * The return is the full `ToolResult`, not a narrowed literal: the
	 * narrow version silently DROPPED `content`, so a tool returning an
	 * image block had it discarded here — before the wire mapper built to
	 * carry it ever saw it.
	 */
	private async runOnce(
		toolName: string,
		input: unknown,
		toolContext: ToolContext,
	): Promise<ToolResult> {
		try {
			return await this.executeWithDeadline(toolName, input, toolContext)
		} catch (err) {
			const message = toErrorMessage(err)
			this.log.warn('Tool execution threw', {
				runId: this.config.runId,
				tool: toolName,
				error: message,
			})
			return { success: false, output: '', error: message }
		}
	}

	/**
	 * @returns `override` — text replacing the tool's output, or `null`.
	 *   `retry` — the hook asked for the tool to run again.
	 */
	private async runPostToolHook(
		toolName: string,
		input: unknown,
		toolResult: ToolResult,
	): Promise<{ override: string | null; retry: boolean }> {
		if (!this.config.pluginManager) return { override: null, retry: false }
		const results = await this.config.pluginManager.executeHooks(
			'post_tool_use',
			{ runId: this.config.runId, toolName, toolInput: input, toolResult },
			this.emitEvent,
		)
		let override: string | null = null
		let retry = false
		for (const result of results) {
			switch (result.action) {
				case 'continue':
					continue
				case 'error':
					override = `Error: ${result.message}`
					continue
				// `retry` was a declared variant with no implementation: every
				// site that consumed it threw. Here it finally means something
				// — the hook saw the result and wants the tool run again —
				// and it is bounded by the same per-tool retry budget, so a
				// plugin cannot spin the executor.
				case 'retry':
					retry = true
					continue
				case 'skip':
				case 'modify':
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
		return { override, retry }
	}

	/**
	 * Answer a tool call that policy or a human refused, without executing
	 * it. Emits the same `tool_executing` → `tool_completed` pair as a real
	 * execution so UI cards reach a terminal state instead of hanging in
	 * `executing`, and records a failed activity for the trace.
	 */
	private async recordDenial(toolCall: ToolCall, reason: string): Promise<ToolCallOutcome> {
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

		return { toolCallId: toolCall.id, toolName, output, isError: true }
	}

	private async recordSyntheticHookOutcome(
		toolCallId: string,
		toolName: string,
		input: unknown,
		outcome: { kind: 'skip' | 'error'; output: string },
	): Promise<ToolCallOutcome> {
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
		return { toolCallId, toolName, output: outcome.output, isError: outcome.kind === 'error' }
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

/** Minimal counting semaphore. FIFO, no timeout — the deadline is per-tool. */
class Semaphore {
	private available: number
	private readonly waiters: Array<() => void> = []

	constructor(permits: number) {
		this.available = Math.max(1, permits)
	}

	acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve)
		})
	}

	release(): void {
		const next = this.waiters.shift()
		if (next) next()
		else this.available++
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
