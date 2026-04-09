import { z } from 'zod'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	query: z.string().describe('Tool name or capability keyword to search for'),
})

export const SearchToolsTool = defineTool({
	name: 'search_tools',
	description:
		'Search and load available tools by name or capability. ' +
		'Deferred tools listed in the system prompt must be loaded via this tool before use.',
	inputSchema,
	category: 'analysis',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		if (!context.toolRegistry) {
			return {
				success: false,
				output: '',
				error: 'Tool registry not available in this context.',
			}
		}

		const matches = context.toolRegistry.searchDeferred(input.query)

		if (matches.length === 0) {
			return {
				success: true,
				output: `No deferred tools matching "${input.query}". All matching tools are already active.`,
			}
		}

		context.toolRegistry.activate(matches.map((t) => t.name))

		const descriptions = matches.map((t) => `- ${t.name}: ${t.description}`).join('\n')

		return {
			success: true,
			output: `Activated ${matches.length} tool(s):\n${descriptions}`,
			data: {
				activated: matches.map((t) => t.name),
				count: matches.length,
			},
		}
	},
})
