import { z } from 'zod'
import { toolDiscoveryHint } from '../../registry/tool/execute.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

/** The most names one `select:` list loads. */
export const MAX_SELECT_NAMES = 64

/**
 * Results a search loads when `max_results` is not given. Top-5 is the
 * literature's sweet spot (retrieval at k=5 matches oracle toolsets) and
 * bounds how much schema weight a single search can add to every later
 * iteration; each activation also busts the prompt-cache prefix once.
 */
export const DEFAULT_MAX_RESULTS = 5

const inputSchema = z.object({
	query: z
		.string()
		.describe(
			'"select:name1,name2" to load exactly those tools by name, or keywords to search, or "+term" words that every result must contain',
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(MAX_SELECT_NAMES)
		.optional()
		.describe(`Most tools a keyword search loads (default ${DEFAULT_MAX_RESULTS})`),
})

const SELECT_PREFIX = /^select:(.*)$/is

// Near-misses are reported name+hint WITHOUT activating, so a retrieval
// miss becomes one cheap re-query instead of a dead end (the fixed-top-k
// hard-tail failure mode: the right tool ranked 6th-10th).
const NEAR_MISS_LIMIT = 5

export const SearchToolsTool = defineTool({
	name: 'search_tools',
	description:
		'Load deferred tools so they can be called. ' +
		'Use this only when a needed deferred tool schema is absent from the current runtime tools parameter. If its schema is already visible, call the tool directly without searching again.\n\n' +
		'Query forms:\n' +
		'- "select:read_memory,save_memory" loads exactly those tools by name. Use it when you know the names.\n' +
		'- "notebook jupyter" searches by keywords. A word in a tool\'s name ranks far above a word in its description. Loads the best matches, up to max_results (default 5).\n' +
		'- "+slack send" requires "slack" in the result and ranks by the rest.\n' +
		"A query that is exactly one tool's name loads that tool and no other match, plus any companions it declares.",
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
		const registry = context.toolRegistry
		const allowed = context.allowedTools !== undefined ? new Set(context.allowedTools) : null
		const permitted = (name: string) => !allowed || allowed.has(name)

		const select = SELECT_PREFIX.exec(input.query.trim())
		if (select) {
			const requested = (select[1] ?? '')
				.split(',')
				.map((name) => name.trim())
				.filter((name) => name.length > 0)
			const names = requested.slice(0, MAX_SELECT_NAMES)
			const dropped = requested.slice(MAX_SELECT_NAMES)
			const picked = registry.select
				? registry.select(names)
				: selectByName(registry.searchDeferred.bind(registry), registry.has.bind(registry), names)
			const found = picked.found.filter((tool) => permitted(tool.name))
			const refused = picked.found.filter((tool) => !permitted(tool.name)).map((tool) => tool.name)
			const sections: string[] = []
			if (found.length > 0) sections.push(describeLoaded(found, new Map()))
			const companions = found.flatMap((tool) =>
				(tool.loadsWith ?? []).filter(
					(name) => !found.some((other) => other.name === name) && permitted(name),
				),
			)
			if (companions.length > 0) {
				sections.push(
					`Related tools that are not loaded: ${[...new Set(companions)].join(', ')}. Select them too if you need them.`,
				)
			}
			// A short MCP name that matched several tools loads all of them; say so,
			// so the model is not surprised by tools it did not name in full.
			const ambiguous = names.flatMap((name) => {
				const suffix = `__${name.toLowerCase()}`
				const hits = found.filter(
					(tool) =>
						tool.name.toLowerCase() !== name.toLowerCase() &&
						tool.name.toLowerCase().endsWith(suffix),
				)
				return hits.length > 1 ? [`${name} (${hits.map((tool) => tool.name).join(', ')})`] : []
			})
			if (ambiguous.length > 0) {
				sections.push(
					`A short name matched more than one tool, and all of them are loaded: ${ambiguous.join('; ')}. Use the full name to load one.`,
				)
			}
			if (dropped.length > 0) {
				sections.push(
					`Not loaded, because one select takes at most ${MAX_SELECT_NAMES} names: ${dropped.join(', ')}. Select them in another call.`,
				)
			}
			if (picked.available.length > 0) {
				sections.push(`Already loaded, call directly: ${picked.available.join(', ')}.`)
			}
			const missing = [...picked.missing, ...refused]
			if (missing.length > 0) {
				sections.push(
					`No tool named: ${missing.join(', ')}. A name must be exact; search by keywords to find it.`,
				)
			}
			if (sections.length === 0) {
				return { success: true, output: 'No tool names given after "select:".' }
			}
			return {
				success: true,
				output: sections.join('\n\n'),
				reveals: found.map((tool) => tool.name),
				data: {
					activated: found.map((tool) => tool.name),
					count: found.length,
					...(picked.available.length > 0 ? { alreadyLoaded: picked.available } : {}),
					...(missing.length > 0 ? { missing } : {}),
					...(dropped.length > 0 ? { notSelected: dropped } : {}),
				},
			}
		}

		const limit = input.max_results ?? DEFAULT_MAX_RESULTS
		// `searchDeferred` returns a ranked list (score-descending), so slicing
		// the head is a true top-k reveal, not an arbitrary subset.
		const ranked = registry.searchDeferred(input.query).filter((tool) => permitted(tool.name))

		if (ranked.length === 0) {
			// One sentence for three different states read as "this tool does not exist", and a model
			// that had just used the tool went looking for its own words on disk. Say which state it is.
			const asked = input.query.trim()
			if (registry.has(asked)) {
				if (!permitted(asked)) {
					return {
						success: true,
						output: `${asked} is not available in this session. Carry on without it.`,
					}
				}
				if (registry.availability(asked) === 'active') {
					return { success: true, output: `${asked} is already loaded: call it directly.` }
				}
			}
			return {
				success: true,
				output: `No deferred tools matching "${input.query}". A tool whose schema you can already see is loaded: call it directly. Only names listed under deferred_tools can be loaded; a tool that is not listed there does not exist in this session, so carry on without it.`,
			}
		}

		const activated = ranked.slice(0, limit)
		const nearMisses = ranked.slice(limit, limit + NEAR_MISS_LIMIT)

		// A tool may declare companions that are needed right after it. They
		// load in this same call, from the deferred roster and inside the same
		// allow-list, so the model does not pay a second search for them.
		// Names already activated or already loaded are skipped; one level only.
		const activatedNames = new Set(activated.map((t) => t.name))
		const companions: ToolDefinition[] = []
		for (const tool of activated) {
			for (const name of tool.loadsWith ?? []) {
				if (activatedNames.has(name)) continue
				const companion = registry
					.searchDeferred(name)
					.find((candidate) => candidate.name === name && permitted(name))
				if (!companion) continue
				activatedNames.add(name)
				companions.push(companion)
			}
		}
		const loaded = [...activated, ...companions]
		const companionOf = new Map<string, string>()
		for (const tool of activated) {
			for (const name of tool.loadsWith ?? []) companionOf.set(name, tool.name)
		}

		const sections = [describeLoaded(loaded, companionOf, companions)]

		if (nearMisses.length > 0) {
			const hints = nearMisses
				.map((t) => {
					const hint = toolDiscoveryHint(t.description)
					return hint.length > 0 ? `- ${t.name}: ${hint}` : `- ${t.name}`
				})
				.join('\n')
			sections.push(
				`Also matched but NOT loaded (select one by exact name, "select:<name>", or raise max_results):\n${hints}`,
			)
		}

		return {
			success: true,
			output: sections.join('\n\n'),
			// No `activate()` call: the manager derives availability from what a
			// tool message REVEALS (`ToolResult.reveals`, persisted as
			// `ToolMessage.revealedTools`), not from a mutation made here. See
			// `toolsets/manager.ts`'s `availability()`.
			reveals: loaded.map((t) => t.name),
			data: {
				activated: loaded.map((t) => t.name),
				count: loaded.length,
				nearMisses: nearMisses.map((t) => t.name),
				...(companions.length > 0 ? { companions: companions.map((t) => t.name) } : {}),
			},
		}
	},
})

function describeLoaded(
	loaded: readonly ToolDefinition[],
	companionOf: ReadonlyMap<string, string>,
	companions: readonly ToolDefinition[] = [],
): string {
	const lines = loaded
		.map((t) => {
			const owner = companionOf.get(t.name)
			const note = companions.includes(t) && owner ? ` (loaded with ${owner})` : ''
			return `- ${t.name}${note}: ${t.description}`
		})
		.join('\n')
	return `Activated ${loaded.length} tool(s):\n${lines}`
}

/**
 * `select:` against a view that has no `select` of its own: an exact-name
 * match over the deferred search. Only full names match here; the MCP
 * short-name form needs the manager's own `select`.
 */
function selectByName(
	search: (query: string) => readonly ToolDefinition[],
	has: (name: string) => boolean,
	names: readonly string[],
): {
	readonly found: readonly ToolDefinition[]
	readonly available: readonly string[]
	readonly missing: readonly string[]
} {
	const found: ToolDefinition[] = []
	const available: string[] = []
	const missing: string[] = []
	for (const name of names) {
		const hit = search(name).find((tool) => tool.name.toLowerCase() === name.toLowerCase())
		if (hit) found.push(hit)
		else if (has(name)) available.push(name)
		else missing.push(name)
	}
	return { found, available, missing }
}
