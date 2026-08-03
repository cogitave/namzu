import type { z } from 'zod'
import type {
	ToolContext,
	ToolDefinition,
	ToolPermission,
	ToolResult,
} from '../types/tool/index.js'
import { toErrorMessage } from '../utils/error.js'

export interface DefineToolOptions<S extends z.ZodType> {
	name: string
	description: string
	inputSchema: S
	modelInputSchema?: Record<string, unknown>
	enforceModelInput?: boolean
	validationErrorHint?: string
	category: ToolDefinition['category']
	permissions: ToolPermission[]
	readOnly: boolean
	destructive: boolean | ((input: z.infer<S>) => boolean)
	concurrencySafe: boolean
	tier?: string
	/** Per-execution deadline; see {@link ToolDefinition.timeoutMs}. */
	timeoutMs?: number
	/**
	 * In-loop retry budget for a FAILED execution; see
	 * {@link ToolDefinition.maxRetries}.
	 *
	 * The executor has always read this field, and this builder — the
	 * sanctioned way to author a tool — had no way to set it, so the
	 * documented "the tool author opts in, per tool" was reachable only by
	 * hand-writing the interface.
	 */
	maxRetries?: number
	/** Return shape shown to the model; see {@link ToolDefinition.outputSchema}. */
	outputSchema?: Record<string, unknown>
	/** Settle the run with this tool's output; see {@link ToolDefinition.terminal}. */
	terminal?: boolean
	execute(input: z.infer<S>, context: ToolContext): Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(
	options: DefineToolOptions<S>,
): ToolDefinition<z.infer<S>> {
	type TInput = z.infer<S>

	return {
		name: options.name,
		description: options.description,
		inputSchema: options.inputSchema,
		modelInputSchema: options.modelInputSchema,
		enforceModelInput: options.enforceModelInput,
		validationErrorHint: options.validationErrorHint,
		tier: options.tier,
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
		...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
		...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
		category: options.category,
		permissions: options.permissions,
		isReadOnly: () => options.readOnly,
		isDestructive:
			typeof options.destructive === 'function'
				? options.destructive
				: () => options.destructive as boolean,
		isConcurrencySafe: () => options.concurrencySafe,

		async execute(input: TInput, context: ToolContext): Promise<ToolResult> {
			try {
				return await options.execute(input, context)
			} catch (err) {
				const message = toErrorMessage(err)
				return {
					success: false,
					output: '',
					error: `${options.name} failed: ${message}`,
				}
			}
		},
	}
}
