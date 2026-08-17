import type { z } from 'zod'
import type {
	ToolContext,
	ToolDefinition,
	ToolPermission,
	ToolResult,
} from '../types/tool/index.js'
import type { ToolPresentation } from '../types/tool/presentation.js'
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
	/**
	 * How this tool's call and result should be shown; see
	 * {@link ToolPresentation}.
	 *
	 * Here rather than only on `ToolDefinition` for the reason `maxRetries`
	 * is: this builder is the sanctioned way to author a tool, and a field
	 * the executor reads that the builder cannot set is a field only
	 * hand-written definitions can use.
	 */
	presentCall?: ToolPresentation<z.infer<S>>['presentCall']
	presentResult?: ToolPresentation<z.infer<S>>['presentResult']
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
	/**
	 * The argument holding a shell command line; see
	 * {@link ToolDefinition.commandArgument}.
	 *
	 * Here as well as on the definition for the reason `maxRetries` and
	 * `presentCall` are: this builder is the sanctioned way to author a tool,
	 * and a field a host reads that the builder cannot set is a field only
	 * hand-written definitions can use.
	 */
	commandArgument?: string
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
		...(options.commandArgument !== undefined ? { commandArgument: options.commandArgument } : {}),
		...(options.presentCall ? { presentCall: options.presentCall } : {}),
		...(options.presentResult ? { presentResult: options.presentResult } : {}),
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
