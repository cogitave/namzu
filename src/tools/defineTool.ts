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
	category: ToolDefinition['category']
	permissions: ToolPermission[]
	readOnly: boolean
	destructive: boolean | ((input: z.infer<S>) => boolean)
	concurrencySafe: boolean
	tier?: string
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
		tier: options.tier,
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
