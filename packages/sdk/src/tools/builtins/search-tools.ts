import { z } from 'zod'
import { toolDiscoveryHint } from '../../registry/tool/execute.js'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	query: z.string().describe('Tool name or capability keyword to search for'),
})

// Activate only the best-ranked matches. Top-5 is the literature's sweet
// spot (retrieval at k=5 matches oracle toolsets) and bounds how much
// schema weight a single search can add to every subsequent iteration —
// each activation also busts the prompt-cache prefix once.
const ACTIVATION_TOP_K = 5

// Near-misses are reported name+hint WITHOUT activating, so a retrieval
// miss becomes one cheap re-query instead of a dead end (the fixed-top-k
// hard-tail failure mode: the right tool ranked 6th-10th).
const NEAR_MISS_LIMIT = 5

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

		const allowed =
			context.allowedTools && context.allowedTools.length > 0 ? new Set(context.allowedTools) : null
		// `searchDeferred` returns a ranked list (score-descending), so slicing
		// the head is a true top-k activation, not an arbitrary subset.
		const ranked = context.toolRegistry
			.searchDeferred(input.query)
			.filter((tool) => !allowed || allowed.has(tool.name))

		if (ranked.length === 0) {
			return {
				success: true,
				output: `No deferred tools matching "${input.query}". All matching tools are already active.`,
			}
		}

		const activated = ranked.slice(0, ACTIVATION_TOP_K)
		const nearMisses = ranked.slice(ACTIVATION_TOP_K, ACTIVATION_TOP_K + NEAR_MISS_LIMIT)

		context.toolRegistry.activate(activated.map((t) => t.name))

		const descriptions = activated.map((t) => `- ${t.name}: ${t.description}`).join('\n')
		const sections = [`Activated ${activated.length} tool(s):\n${descriptions}`]

		if (nearMisses.length > 0) {
			const hints = nearMisses
				.map((t) => {
					const hint = toolDiscoveryHint(t.description)
					return hint.length > 0 ? `- ${t.name}: ${hint}` : `- ${t.name}`
				})
				.join('\n')
			sections.push(
				`Also matched but NOT loaded (search again with a more specific query, e.g. the tool name, to load one of these):\n${hints}`,
			)
		}

		return {
			success: true,
			output: sections.join('\n\n'),
			data: {
				activated: activated.map((t) => t.name),
				count: activated.length,
				nearMisses: nearMisses.map((t) => t.name),
			},
		}
	},
})
