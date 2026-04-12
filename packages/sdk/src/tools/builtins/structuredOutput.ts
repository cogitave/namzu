import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export const STRUCTURED_OUTPUT_TOOL_NAME = 'structured_output' as const

/**
 * Creates a structured output tool that wraps a Zod schema.
 *
 * This tool is used to force the model to produce validated output by presenting
 * the output schema as a special tool that must be called. The tool executes
 * immediately upon invocation (validation happens via Zod schema).
 *
 * @param schema - A Zod schema that defines the output structure
 * @returns A ToolDefinition that validates and returns the structured output
 *
 * @example
 * ```typescript
 * const outputSchema = z.object({
 *   title: z.string(),
 *   summary: z.string(),
 * })
 *
 * const tool = createStructuredOutputTool(outputSchema)
 * // Model calls: structured_output({ title: "...", summary: "..." })
 * // Tool returns: { success: true, output: JSON.stringify({...}) }
 * ```
 */
export function createStructuredOutputTool<TSchema extends z.ZodType>(
	schema: TSchema,
): ReturnType<typeof defineTool<TSchema>> {
	type TInput = z.infer<TSchema>

	return defineTool({
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		description:
			'Use this tool to provide your final structured response. You MUST call this tool with your answer.',
		inputSchema: schema,
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,

		async execute(input: TInput, _context: ToolContext): Promise<ToolResult> {
			// Input is already validated by Zod schema before this function is called.
			// Simply return the validated output.
			return {
				success: true,
				output: JSON.stringify(input),
				data: input,
			}
		},
	})
}
