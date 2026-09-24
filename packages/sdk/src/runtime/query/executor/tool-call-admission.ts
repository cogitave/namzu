import { GENAI, NAMZU } from '../../../constants/telemetry/index.js'
import { callableToolNames, formatToolNames } from '../../../registry/tool/callable.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import type { ToolCall } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ToolCallRepair, ToolCallRepairReason } from '../../../types/tool/repair.js'
import { toErrorMessage } from '../../../utils/error.js'
import type { Logger } from '../../../utils/logger.js'
import type {
	EmitEvent,
	PreToolHookOutcome,
	PreparedDirectCall,
	ToolExecutorConfig,
} from '../executor.js'
import { skippedToolResultText } from '../plugin-hooks.js'

/**
 * One provider tool call, from raw to admitted.
 *
 * The executor's job is to run tools; this is the gate every call passes
 * before one runs. A call arrives as the model streamed it — possibly not
 * valid JSON, possibly cut off mid-argument, possibly naming a tool that does
 * not exist — and leaves as a prepared, plugin-approved, authorized call, or
 * as a synthetic failure that answers the model with what was wrong. Nothing
 * here dispatches a tool, and nothing here writes a result: that is the
 * executor's half.
 *
 * The family reads exactly four things off the executor it serves, and they
 * arrive as one value rather than as a captured reference: the tool registry
 * config, the event sink, the logger and the current step's allow-list.
 * `config` in particular is read per call and never held —
 * `ToolExecutor.setSandbox` REPLACES it, so a host captured once would hand
 * the next admission a stale sandbox.
 */
export interface ToolAdmissionHost {
	readonly config: ToolExecutorConfig
	readonly emitEvent: EmitEvent
	readonly log: Logger
	/**
	 * What the current step may call: the step's own list where
	 * `prepareStep` gave one, the turn's `allowedTools` otherwise, absent
	 * when nothing narrowed the turn. NOT `config.allowedTools`, which is
	 * only the turn's; the step's list lives on the executor.
	 *
	 * Required, with `undefined` as a value, so that a host has to say.
	 * Leaving it out would list the whole registry to a model on a narrowed
	 * step, which is the answer that sent a model round in a circle.
	 */
	readonly allowedTools: readonly string[] | undefined
}

/**
 * The answer to a call naming a tool the registry does not hold, without
 * the `Error: ` a direct call's result carries.
 *
 * It lists what the current step can call — the same list a step refusal
 * gives — rather than what the registry holds. The registry's own
 * "Not found" lists every tool it has, and on a narrowed step that is
 * mostly tools the next call would be refused.
 */
export function unknownToolMessage(host: ToolAdmissionHost, toolName: string): string {
	return `Unknown tool "${toolName}". Available: ${formatToolNames(
		callableToolNames(host.config.tools, host.allowedTools),
	)}`
}

export async function runPreToolHook(
	host: ToolAdmissionHost,
	toolName: string,
	input: unknown,
	signal: AbortSignal = host.config.abortSignal,
): Promise<PreToolHookOutcome> {
	if (!host.config.pluginManager) return { kind: 'continue', input, modified: false }
	const results = await host.config.pluginManager.executeHooks(
		'pre_tool_use',
		{
			sessionId: host.config.sessionId,
			turnId: host.config.turnId,
			toolName,
			toolInput: input,
			signal,
		},
		host.emitEvent,
	)
	return interpretPreToolResults(toolName, input, results)
}

export async function prepareDirectCall(
	host: ToolAdmissionHost,
	toolCall: ToolCall,
): Promise<PreparedDirectCall> {
	let toolName = toolCall.function.name
	const truncationRepair =
		toolCall.metadata?.inputTruncated === true
			? await repairTruncatedCall(host, toolCall, toolName)
			: null
	if (toolCall.metadata?.inputTruncated === true && !truncationRepair) {
		return {
			kind: 'synthetic',
			toolCall,
			toolName,
			input: {},
			message: truncatedToolInputMessage(toolName),
			isError: true,
		}
	}

	const prepare = host.config.tools.prepareExecution
	const executePrepared = host.config.tools.executePrepared
	if (typeof prepare !== 'function' || typeof executePrepared !== 'function') {
		const resolved = await resolveCall(
			host,
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
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: {},
				message: resolved.message,
				isError: true,
			}
		}
		const preOutcome = await runPreToolHook(host, toolName, resolved.input)
		if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: preOutcome.input,
				message: preOutcome.output,
				isError: preOutcome.kind === 'error',
			}
		}
		if (!host.config.authorizationGate) {
			return {
				kind: 'legacy',
				toolCall,
				toolName,
				input: preOutcome.input,
			}
		}
		return {
			kind: 'synthetic',
			toolCall,
			toolName,
			input: preOutcome.input,
			message: `Tool "${toolName}" was not executed because its registry cannot bind authorization to one prepared input.`,
			isError: true,
		}
	}

	let raw = truncationRepair?.arguments ?? toolCall.function.arguments
	toolName = truncationRepair?.toolName ?? toolName
	let repairUsed = truncationRepair !== null
	let preparation: ReturnType<typeof prepare>
	for (;;) {
		let parsed: unknown
		try {
			parsed = parseArguments(raw)
		} catch {
			const message = `Error: Invalid JSON in tool arguments for "${toolName}"`
			const repair =
				!repairUsed && host.config.repairToolCall
					? await requestRepair(host, toolCall, toolName, {
							reason: 'invalid_json',
							message,
						})
					: null
			if (repair) {
				repairUsed = true
				toolName = repair.toolName ?? toolName
				raw = repair.arguments
				continue
			}
			return { kind: 'synthetic', toolCall, toolName, input: {}, message, isError: true }
		}

		try {
			preparation = prepare.call(host.config.tools, toolName, parsed)
		} catch (err) {
			// A name the registry does not hold gets the step's list, not the
			// registry's "Not found", which lists everything it holds.
			const message = isUnregistered(host, toolName)
				? `Error: ${unknownToolMessage(host, toolName)}`
				: `Error: Unknown or unavailable tool "${toolName}": ${toErrorMessage(err)}`
			const repair =
				!repairUsed && host.config.repairToolCall
					? await requestRepair(host, toolCall, toolName, {
							reason: 'unknown_tool',
							message,
						})
					: null
			if (repair) {
				repairUsed = true
				toolName = repair.toolName ?? toolName
				raw = repair.arguments
				continue
			}
			return { kind: 'synthetic', toolCall, toolName, input: parsed, message, isError: true }
		}

		if (preparation.success) break
		const message = formatFailedToolOutput(preparation.result.output, preparation.result.error)
		const repair =
			!repairUsed && host.config.repairToolCall
				? await requestRepair(host, toolCall, toolName, {
						reason: 'schema_validation',
						message,
					})
				: null
		if (repair) {
			repairUsed = true
			toolName = repair.toolName ?? toolName
			raw = repair.arguments
			continue
		}
		return {
			kind: 'synthetic',
			toolCall,
			toolName,
			input: parsed,
			message,
			isError: true,
		}
	}

	const preOutcome = await runPreToolHook(host, toolName, preparation.prepared.input)
	if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
		return {
			kind: 'synthetic',
			toolCall,
			toolName,
			input: preOutcome.input,
			message: preOutcome.output,
			isError: preOutcome.kind === 'error',
		}
	}

	if (preOutcome.modified) {
		const modified = prepare.call(host.config.tools, toolName, preOutcome.input)
		if (!modified.success) {
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: preOutcome.input,
				message: formatFailedToolOutput(modified.result.output, modified.result.error),
				isError: true,
			}
		}
		preparation = modified
	}

	return {
		kind: 'ready',
		toolCall,
		toolName,
		input: preparation.prepared.input,
		prepared: preparation.prepared,
	}
}

function interpretPreToolResults(
	toolName: string,
	initialInput: unknown,
	results: readonly PluginHookResult[],
): PreToolHookOutcome {
	let currentInput = initialInput
	let modified = false
	for (const result of results) {
		switch (result.action) {
			case 'continue':
				continue
			case 'modify':
				currentInput = result.input
				modified = true
				continue
			case 'skip':
				return {
					kind: 'skip',
					input: currentInput,
					output: skippedToolResultText(toolName, result.reason),
				}
			case 'error':
				return {
					kind: 'error',
					input: currentInput,
					output: `Error: ${result.message}`,
				}
			case 'retry':
			case 'annotate':
			// There is no result to replace yet. Rejecting loudly beats
			// silently ignoring it: a hook author who returned this here
			// meant to redact something and would otherwise watch the secret
			// go through.
			case 'replace':
				throw new Error(
					`Plugin hook pre_tool_use returned unsupported action '${result.action}' for tool ${toolName}`,
				)
			default: {
				const _exhaustive: never = result
				throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
			}
		}
	}
	return { kind: 'continue', input: currentInput, modified }
}

/**
 * Turn the call the model issued into a name and a parsed input, giving
 * a configured repairer one chance to fix it first.
 *
 * Exactly one chance: a repairer that produces a call which is still
 * broken will not do better on a second look, and an unbounded loop
 * here is a hang rather than a degradation.
 *
 * `invalid_json` stops the call here, and it stopped it before this
 * function existed too. So does an `unknown_tool` the registry confirms
 * it does not hold: the registry's own answer to that is "Not found",
 * listing every tool it has, where the model needs the ones this step can
 * call — see `unknownToolMessage`. `schema_validation`, and an unknown
 * tool on a registry that cannot say, merely OFFER the repair and
 * otherwise fall through to the registry, whose schema error already
 * ships a "Required: <field>: <type>" hint the model can self-correct
 * from.
 */
export async function resolveCall(
	host: ToolAdmissionHost,
	toolCall: ToolCall,
): Promise<
	{ ok: true; toolName: string; input: unknown } | { ok: false; toolName: string; message: string }
> {
	let toolName = toolCall.function.name
	let raw = toolCall.function.arguments

	for (let attempt = 0; ; attempt++) {
		const failure = inspectCall(host, toolName, raw)
		if (!failure) return { ok: true, toolName, input: parseArguments(raw) }

		const repair =
			attempt === 0 && host.config.repairToolCall
				? await requestRepair(host, toolCall, toolName, failure)
				: null

		if (!repair) {
			if (
				failure.reason === 'invalid_json' ||
				(failure.reason === 'unknown_tool' && isUnregistered(host, toolName))
			) {
				return { ok: false, toolName, message: failure.message }
			}
			return { ok: true, toolName, input: parseArguments(raw) }
		}

		host.log.info('Repaired a malformed tool call', {
			[NAMZU.TURN_ID]: host.config.turnId,
			[GENAI.TOOL_NAME]: toolName,
			'namzu.runtime.reason': failure.reason,
			...(repair.toolName && repair.toolName !== toolName
				? { 'namzu.runtime.repaired_to': repair.toolName }
				: {}),
		})
		toolName = repair.toolName ?? toolName
		raw = repair.arguments
	}
}

export async function repairTruncatedCall(
	host: ToolAdmissionHost,
	toolCall: ToolCall,
	toolName: string,
): Promise<ToolCallRepair | null> {
	if (!host.config.repairToolCall) return null

	// Present the PARTIAL buffer, not the normalized `"{}"` — a repairer
	// handed an empty object has nothing to work from.
	const partial = toolCall.metadata?.partialArguments ?? ''
	const repair = await requestRepair(
		host,
		{ ...toolCall, function: { ...toolCall.function, arguments: partial } },
		toolName,
		{ reason: 'invalid_json', message: truncatedToolInputMessage(toolName) },
	)
	if (repair) {
		host.log.info('Repaired a tool call whose input stream was truncated', {
			[NAMZU.TURN_ID]: host.config.turnId,
			[GENAI.TOOL_NAME]: toolName,
			'namzu.runtime.partial_length': partial.length,
		})
	}
	return repair
}

/**
 * What is wrong with this call, or `null` if nothing is.
 *
 * JSON is checked before the tool is looked up: an unparseable argument
 * string is broken regardless of which tool it was aimed at, and it is
 * the one problem the executor itself has to answer.
 */
function inspectCall(
	host: ToolAdmissionHost,
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

	const tool = host.config.tools.get?.(toolName)
	if (!tool) {
		// Either the model named a tool that does not exist, or this
		// registry does not implement `get`. A repairer gets offered both;
		// only the first is answered here, and with the step's list.
		return {
			reason: 'unknown_tool',
			message: isUnregistered(host, toolName)
				? `Error: ${unknownToolMessage(host, toolName)}`
				: `Error: Unknown tool "${toolName}"`,
		}
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

/** The registry says it does not hold this name — not merely that it cannot look it up. */
export function isUnregistered(host: ToolAdmissionHost, toolName: string): boolean {
	return typeof host.config.tools.has === 'function' && !host.config.tools.has(toolName)
}

async function requestRepair(
	host: ToolAdmissionHost,
	toolCall: ToolCall,
	toolName: string,
	failure: { reason: ToolCallRepairReason; message: string },
): Promise<ToolCallRepair | null> {
	const repairToolCall = host.config.repairToolCall
	if (!repairToolCall) return null

	const tool = host.config.tools.get(toolName)
	try {
		return await repairToolCall({
			toolCall,
			reason: failure.reason,
			message: failure.message,
			...(tool
				? {
						tool,
						jsonSchema: tool.modelInputSchema ?? renderToolSchema(tool.inputSchema),
					}
				: {}),
			availableTools: host.config.tools.listNames(),
		})
	} catch (err) {
		// A broken repairer must not turn a recoverable tool error into a
		// failed turn: the original error is still a perfectly good answer
		// to give the model.
		host.log.error('repairToolCall threw — falling back to the original error', {
			[NAMZU.TURN_ID]: host.config.turnId,
			[GENAI.TOOL_NAME]: toolName,
			'exception.message': toErrorMessage(err),
		})
		return null
	}
}

/**
 * An empty arguments string means "no arguments", not "malformed" — the
 * shape a no-parameter tool arrives in.
 */
function parseArguments(raw: string): unknown {
	return JSON.parse(raw || '{}')
}

export function formatFailedToolOutput(
	output: string | undefined,
	error: string | undefined,
): string {
	const errorText = `Error: ${error ?? 'Tool execution failed'}`
	if (!output || output.trim().length === 0) return errorText
	return `${output}\n\n${errorText}`
}

export function truncatedToolInputMessage(toolName: string): string {
	return `Error: Tool "${toolName}" call was cut off while the model was streaming JSON arguments. The tool was NOT executed. Retry with a much shorter input. Self-budget content/new_string under 12000 characters before calling file tools. For long files, create a short opening with write and a deterministic marker, then advance that marker with bounded exact edit calls; for delegated work, pass a shared workspace filename/reference instead of embedding the content in the tool call.`
}
