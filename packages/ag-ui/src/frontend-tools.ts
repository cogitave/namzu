import type { Tool } from '@ag-ui/core'
import { type ToolDefinition, defineTool } from '@namzu/sdk'
import { z } from 'zod'
import { AGUIRequestError } from './errors.js'
import { isPlainObject } from './interrupts.js'

/**
 * Which of the tools a client declares in `RunAgentInput.tools` the model may
 * call. Without this option every request that declares one is refused.
 */
export interface AGUIFrontendToolOptions {
	/** Declared tools the host admits: their names, or a predicate over the declaration. */
	readonly allow: readonly string[] | ((tool: Tool) => boolean)
	/**
	 * A declared tool outside `allow`: `'refuse'` (the default) answers the
	 * request with 422, `'omit'` leaves the tool out and serves the request.
	 */
	readonly unlisted?: 'refuse' | 'omit'
}

/** The park name a frontend call waits for its result under (`<toolUseId>:<name>`). */
export const FRONTEND_RESULT_PAUSE = 'agui_client_result'

/** What the client's `tool` message carried, as the waiting tool receives it. */
export interface FrontendToolResult {
	readonly content: string
	readonly isError: boolean
}

export function encodeFrontendResult(result: FrontendToolResult): string {
	return JSON.stringify(result)
}

function decodeFrontendResult(text: string | undefined): FrontendToolResult | undefined {
	if (text === undefined) return undefined
	try {
		const value: unknown = JSON.parse(text)
		if (
			isPlainObject(value) &&
			typeof value.content === 'string' &&
			typeof value.isError === 'boolean'
		)
			return { content: value.content, isError: value.isError }
	} catch {
		/* Not ours: reported below as no result. */
	}
	return undefined
}

/** What the adapter learns about a frontend call when the tool starts waiting. */
export type FrontendCallObserver = (call: {
	readonly toolCallId: string
	readonly toolName: string
	readonly input: unknown
}) => void

// The SDK registry's own name pattern, checked here so a bad name is the
// request's error rather than a registration failure inside the host.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * The declared tools the host admits, as SDK tool definitions whose
 * execution waits for the client's result.
 *
 * Each call still goes through the turn's authorization gate and review like
 * any tool; a call the gate denies never reaches the client. The definitions
 * are `readOnly` because the server does nothing but wait: whatever the tool
 * changes, it changes in the client. A host that wants review anyway writes a
 * `review` rule naming the tool.
 */
export function admitFrontendTools(
	declared: readonly Tool[],
	options: AGUIFrontendToolOptions | undefined,
	settings: { readonly timeoutMs: number; readonly observe: FrontendCallObserver },
): ToolDefinition[] {
	if (declared.length === 0) return []
	if (!options)
		throw new AGUIRequestError(
			'Frontend tool execution is not enabled on this endpoint.',
			422,
			'UNSUPPORTED_FRONTEND_TOOLS',
		)
	const allowed =
		typeof options.allow === 'function'
			? options.allow
			: (tool: Tool) => (options.allow as readonly string[]).includes(tool.name)
	const names = new Set<string>()
	const admitted: ToolDefinition[] = []
	for (const tool of declared) {
		if (names.has(tool.name))
			throw new AGUIRequestError(
				'Frontend tool names must be unique.',
				422,
				'INVALID_FRONTEND_TOOL',
			)
		names.add(tool.name)
		if (!allowed(tool)) {
			if (options.unlisted === 'omit') continue
			throw new AGUIRequestError(
				'The request declares a frontend tool this endpoint does not admit.',
				422,
				'UNSUPPORTED_FRONTEND_TOOLS',
			)
		}
		if (!TOOL_NAME.test(tool.name))
			throw new AGUIRequestError(
				'A frontend tool name uses 1 to 64 letters, digits, `_` or `-`.',
				422,
				'INVALID_FRONTEND_TOOL',
			)
		admitted.push(frontendTool(tool, settings))
	}
	return admitted
}

function frontendTool(
	tool: Tool,
	settings: { readonly timeoutMs: number; readonly observe: FrontendCallObserver },
): ToolDefinition {
	const parameters = isPlainObject(tool.parameters) ? tool.parameters : undefined
	return defineTool({
		name: tool.name,
		description: tool.description,
		inputSchema: z.record(z.unknown()),
		modelInputSchema: parameters ?? { type: 'object', properties: {} },
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		// One client action at a time: parks on one turn are answered in the
		// order the client sees them, and a batch of client calls is one
		// continuation either way.
		concurrencySafe: false,
		timeoutMs: settings.timeoutMs,
		async execute(input, context) {
			if (!context.requestPause || !context.toolUseId) {
				return {
					success: false,
					output: '',
					error: `${tool.name} runs in the client, and this turn cannot wait for its result.`,
				}
			}
			settings.observe({ toolCallId: context.toolUseId, toolName: tool.name, input })
			const outcome = await context.requestPause({
				name: FRONTEND_RESULT_PAUSE,
				prompt: `Run ${tool.name} in the client and return its result.`,
				allowFreeText: true,
			})
			if (outcome.status === 'aborted') {
				return {
					success: false,
					output: '',
					error: `${tool.name} was cancelled before the client answered.`,
				}
			}
			const result = outcome.status === 'answered' ? decodeFrontendResult(outcome.text) : undefined
			if (!result) {
				return {
					success: false,
					output: '',
					error: `The client did not return a result for ${tool.name}. Do not assume it ran.`,
				}
			}
			return result.isError
				? { success: false, output: result.content, error: result.content }
				: { success: true, output: result.content }
		},
	})
}
