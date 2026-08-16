import { z } from 'zod'

import type { CodeNavigationProvider } from '../../types/code-navigation/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinReal } from '../paths.js'

/**
 * Symbol navigation, for the questions `grep` answers wrongly.
 *
 * An agent asked to find every call site of a function had `grep`: every
 * textual occurrence, including the comment that mentions it, the string
 * literal that names it, and the unrelated same-named symbol in another
 * scope — and MISSING the call sites that arrive through a re-export or a
 * destructure, which is the half a rename has to get right.
 *
 * **Not in `getBuiltinTools()`, and not registered when no provider is
 * configured.** A tool that is always present and always answers
 * "unavailable" costs a decision on every turn to say nothing, and it
 * teaches a model that this capability exists when it does not. `bash`'s
 * companion `job` tool ships unconditionally for the opposite reason — it
 * has a real answer either way — and the difference is worth stating
 * because the two look alike from the outside.
 */

const inputSchema = z.object({
	operation: z
		.enum(['definition', 'references'])
		.describe(
			'`definition` finds where the symbol under the position is declared. `references` finds everywhere it is used, which is what a rename or a deletion needs.',
		),
	path: z.string().describe('File containing the symbol, relative to the working directory.'),
	line: z.number().int().min(0).describe('Zero-based line of the symbol.'),
	character: z.number().int().min(0).describe('Zero-based column of the symbol.'),
})

type LspInput = z.infer<typeof inputSchema>

export const LSP_TOOL_NAME = 'lsp'

export const LspTool = defineTool({
	name: LSP_TOOL_NAME,
	description:
		'Resolves a symbol through a language server: where it is declared, and everywhere it is used. Use it instead of grep when the answer has to be right — grep finds the identifier in comments and strings and misses call sites that come through a re-export.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input: LspInput, context): Promise<ToolResult> {
		const provider = context.codeNavigation
		if (!provider) {
			// Reachable only if a host registered this tool without a provider.
			// The registration path does not, so this is the refusal for a host
			// that wired it up by hand — and it names the missing piece rather
			// than reading as "no results".
			return {
				success: false,
				output: '',
				error:
					'This run has no code navigation provider, so there is nothing to resolve against. A host supplies one on the tool context; `grep` is the fallback, and it answers a different question.',
			}
		}

		// Contained BEFORE the path reaches the server, with the same
		// containment `read` and `grep` use. A language server indexes a
		// workspace and will happily answer about `../../etc/passwd` if asked;
		// the boundary is this tool's job, not the server's.
		let absolute: string
		try {
			absolute = await resolveWithinReal(context.workingDirectory, input.path)
		} catch (err) {
			return {
				success: false,
				output: '',
				error: err instanceof Error ? err.message : String(err),
			}
		}

		const result =
			input.operation === 'definition'
				? await provider.definition(absolute, input.line, input.character)
				: await provider.references(absolute, input.line, input.character)

		switch (result.kind) {
			case 'locations': {
				if (result.locations.length === 0) {
					// A real answer: the server looked and there are none. Said
					// plainly, because "no references" is what a deletion needs to
					// hear and it must not be confused with a failure.
					return {
						success: true,
						output: `No ${input.operation} found for the symbol at ${input.path}:${input.line}:${input.character}.`,
						data: { operation: input.operation, count: 0, locations: [] },
					}
				}
				const lines = result.locations.map((l) => `${l.path}:${l.line}:${l.character}`)
				return {
					success: true,
					output: lines.join('\n'),
					data: {
						operation: input.operation,
						count: result.locations.length,
						locations: result.locations,
					},
				}
			}
			case 'unsupported':
				// Distinct from a failure on purpose: the model can fall back to
				// `grep` and know why the answer is approximate.
				return {
					success: false,
					output: '',
					error: `${result.reason} Fall back to \`grep\`, and treat the result as textual rather than resolved.`,
				}
			case 'failed':
				// NOT an empty result. An agent told a symbol has no callers
				// deletes it; an agent told the resolver broke does something else.
				return {
					success: false,
					output: '',
					error: `Code navigation failed, so this answer is unknown rather than empty: ${result.error}`,
				}
		}
	},
})

/**
 * The tool, only when there is something for it to call.
 *
 * A function rather than a constant because the decision is per run: the
 * same process can serve one session with a language server and one
 * without, and a module-level constant would have to pick.
 */
export function getCodeNavigationTools(
	provider: CodeNavigationProvider | undefined,
): (typeof LspTool)[] {
	return provider ? [LspTool] : []
}
