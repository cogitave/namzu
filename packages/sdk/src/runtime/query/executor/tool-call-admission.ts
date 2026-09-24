import { GENAI, NAMZU } from '../../../constants/telemetry/index.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import type { ToolCall, ToolInputError } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
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
 * The family reads exactly three things off the executor it serves, and they
 * arrive as one value rather than as a captured reference: the tool registry
 * config, the event sink and the logger. `config` in particular is read
 * per call and never held — `ToolExecutor.setSandbox` REPLACES it, so a host
 * captured once would hand the next admission a stale sandbox.
 */
export interface ToolAdmissionHost {
	readonly config: ToolExecutorConfig
	readonly emitEvent: EmitEvent
	readonly log: Logger
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
			message: unreadableToolCallMessage(host, toolCall, toolName),
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
			const message = `Error: Unknown or unavailable tool "${toolName}": ${toErrorMessage(err)}`
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
 * `invalid_json` is the ONLY failure that stops the call here, and it
 * stopped it before this function existed too. `unknown_tool` and
 * `schema_validation` merely OFFER the repair and otherwise fall
 * through to the registry, which reports both with better messages —
 * its schema error already ships a "Required: <field>: <type>" hint the
 * model can self-correct from. So with no repairer configured this is
 * behaviorally identical to the bare `JSON.parse` it replaced.
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
			if (failure.reason === 'invalid_json') {
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
		{ reason: 'invalid_json', message: unreadableToolCallMessage(host, toolCall, toolName) },
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
		// registry does not implement `get`. Both are the registry's to
		// answer; a repairer still gets offered the `unknown_tool` case.
		return {
			reason: 'unknown_tool',
			message: `Error: Unknown tool "${toolName}"`,
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

/**
 * The message a call with unreadable arguments is answered with, built from
 * why they could not be read and from the tool the call named.
 */
export function unreadableToolCallMessage(
	host: ToolAdmissionHost,
	toolCall: ToolCall,
	toolName: string,
): string {
	return unreadableToolInputMessage(
		toolName,
		toolCall.metadata?.inputError,
		host.config.tools.get?.(toolName),
	)
}

/**
 * How much one call should carry, in the model's words, or `undefined` when
 * there is no number to give: a stream that ended, to a tool that declares no
 * large arguments.
 *
 * A tool that declares large arguments is given a budget for each of them.
 * After an output limit, any tool is told to keep its arguments under half of
 * what arrived: the whole of them for a tool that declares none, and each
 * declared budget lowered to that half when it is larger, since a budget the
 * response could not hold would send the model straight back into the cutoff.
 * How to carry less (in parts, in a file) is the tool's own
 * `truncatedInputHint`: splitting is right for a file body and wrong for a
 * delegated prompt.
 */
function sizeAdvice(
	largeStringArguments: ToolDefinition['largeStringArguments'],
	error: ToolInputError,
): string | undefined {
	const ceiling =
		error.finishReason === 'length'
			? Math.max(100, Math.floor(error.length / 2 / 100) * 100)
			: undefined
	const declared = Object.entries(largeStringArguments ?? {}).filter(
		([, budget]) => Number.isFinite(budget) && budget > 0,
	)
	if (declared.length === 0) {
		return ceiling === undefined
			? undefined
			: `Send it again with less in one call: keep its arguments under ${ceiling} characters in all.`
	}
	const budgets = declared.map(
		([name, budget]) =>
			`\`${name}\` under ${Math.floor(Math.min(budget, ceiling ?? Number.POSITIVE_INFINITY))} characters`,
	)
	const list =
		budgets.length === 1
			? budgets[0]
			: `${budgets.slice(0, -1).join(', ')} and ${budgets[budgets.length - 1]}`
	return `Send it again with less in one call: keep ${list}.`
}

/**
 * What to tell the model about a call whose arguments could not be read.
 *
 * Each part answers one question, and a part with no answer is left out:
 * what happened (from `error`, which says cut off or malformed and why), and
 * what to do about it.
 *
 * - Malformed: send one valid JSON object, and the tool's own
 *   `malformedInputHint`. Never size advice: size does not fix JSON.
 * - Cut off by the output limit: first, which part of the response filled it.
 *   A call that was less than half of it (`length` against `responseLength`)
 *   did not; the text and calls before it did, and the model is told to send
 *   less before it, with no advice about the call. Otherwise the call itself
 *   is to carry less: {@link sizeAdvice}, and the tool's `truncatedInputHint`.
 * - Cut off by the stream ending: the declared budgets, if any, or just to
 *   send the call again, and the tool's `truncatedInputHint`.
 * - Stopped by a content filter: no advice. Sending less does not get past a
 *   filter.
 *
 * A call recorded before the reason was kept has no `error` and gets the
 * plain statement that its arguments were unreadable, and no hint, since
 * which one applies is not known.
 */
export function unreadableToolInputMessage(
	toolName: string,
	error: ToolInputError | undefined,
	tool?: Pick<ToolDefinition, 'truncatedInputHint' | 'malformedInputHint' | 'largeStringArguments'>,
): string {
	const parts: string[] = []
	const hint = (text: string | undefined) => {
		const trimmed = text?.trim()
		if (trimmed) parts.push(trimmed)
	}
	if (!error) {
		parts.push(
			`Error: The arguments for "${toolName}" could not be read as JSON. The tool was NOT executed. Send the call again with complete, valid JSON arguments.`,
		)
	} else if (error.reason === 'malformed') {
		const where =
			error.offset !== undefined && !/\bposition \d+/.test(error.parseError)
				? ` at character ${error.offset}`
				: ''
		parts.push(
			`Error: The arguments for "${toolName}" were not valid JSON (${error.parseError}${where}; ${error.length} characters in all). The tool was NOT executed. Send the call again with its arguments as one valid JSON object.`,
		)
		hint(tool?.malformedInputHint)
	} else {
		const cause =
			error.finishReason === 'length'
				? 'the response reached its output token limit'
				: error.finishReason === 'content_filter'
					? "the provider's content filter stopped the response"
					: 'the response stream ended'
		parts.push(
			`Error: The call to "${toolName}" was cut off: ${cause} after ${error.length} characters of its arguments, before they were complete. The tool was NOT executed.`,
		)
		if (error.finishReason === 'length' && error.length * 2 < error.responseLength) {
			parts.push(
				`Most of the response (${error.responseLength} characters) went to what came before this call, so send the call again with less before it in the same response.`,
			)
		} else if (error.finishReason !== 'content_filter') {
			parts.push(sizeAdvice(tool?.largeStringArguments, error) ?? 'Send the call again.')
			hint(tool?.truncatedInputHint)
		}
	}
	return parts.join(' ')
}
