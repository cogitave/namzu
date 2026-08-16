import { z } from 'zod'

import { isInvocableBy, skillInvocation } from '../../types/skills/index.js'
import { defineTool } from '../defineTool.js'

/**
 * Load a skill's instructions, and adopt whatever it says it needs.
 *
 * The manifest in the system prompt told the model that a SKILL.md exists
 * and to "read the SKILL.md at its <location> before writing code" — which
 * is a filesystem instruction, so a run with no filesystem tools could see
 * every skill it had and open none of them. The protocol text even admits
 * it: *"when the runtime exposes filesystem or skill-loading tools"*. There
 * was no skill-loading tool.
 *
 * `allowed-tools` had the same shape of problem from the other side. It was
 * parsed, carried into `SkillMetadata`, rendered into the prompt as
 * `<allowed_tools>…</allowed_tools>` — and read by nothing. It was advice
 * the model could take or ignore, phrased as a declaration.
 */

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe('The skill to load, exactly as listed in the available-skills manifest.'),
})

type SkillInput = z.infer<typeof inputSchema>

/**
 * `allowed-tools` as a list.
 *
 * Comma-separated in the frontmatter because that is what authors write and
 * what the field has always accepted. Split here rather than at parse so
 * the stored metadata keeps the author's own string — the same reasoning
 * `invocation` uses for not defaulting at parse.
 */
export function parseAllowedTools(declared: string | undefined): readonly string[] | undefined {
	if (declared === undefined) return undefined
	const names = declared
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
	// An empty result from a non-empty declaration is a real answer and not
	// the same as "declared nothing": `allowed-tools: ""` is an author
	// saying this skill needs no tools, and collapsing it to `undefined`
	// would silently widen that to everything.
	return names
}

export const SKILL_TOOL_NAME = 'skill'

export const SkillTool = defineTool({
	name: SKILL_TOOL_NAME,
	description:
		'Loads the full instructions for a skill listed in the available-skills manifest. Call this before doing work the skill describes; the manifest carries only names and descriptions.',
	inputSchema,
	category: 'analysis',
	permissions: [],
	// Reads instructions and changes nothing. It is the one tool whose
	// availability a narrowed skill scope must never remove, or a model
	// inside one skill could not reach for another.
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input: SkillInput, context) {
		if (!context.skills) {
			return {
				success: false,
				output: '',
				error:
					'This run has no skills registry, so there is nothing to load. Proceed without the skill.',
			}
		}

		// The registry answers with a load RESULT, not a skill — the shape
		// mirrors the implementation rather than an adapter, so there is
		// nothing between them to drift.
		const loaded = await context.skills.load(input.name)
		if (!loaded) {
			// Named, with what IS available. A bare "not found" sends the model
			// guessing at spellings, and the manifest it is guessing from is
			// right there in its own prompt.
			const available = context.skills.names()
			return {
				success: false,
				output: '',
				error: `No skill named "${input.name}". Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
			}
		}

		const skill = loaded.skill
		if (!isInvocableBy(skill, 'model')) {
			// Reachable even though the manifest omits it: the model can name
			// anything, and a check that only filtered the listing would be a
			// menu restriction rather than a kitchen one — the exact defect
			// `allowedTools` had before it was enforced at dispatch.
			return {
				success: false,
				output: '',
				error: `The skill "${input.name}" is ${skillInvocation(skill)}-invocable; it is not for you to run.`,
			}
		}

		const allowed = parseAllowedTools(skill.metadata.allowedTools)
		if (allowed !== undefined) {
			// Adopted, not merely announced. The notice below tells the model
			// what happened; this is what makes it true whether or not the
			// model reads it — the difference between the field as it was and
			// the field as a declaration.
			//
			// Absent `adoptSkillScope`, the notice still goes out and is all
			// there is: a host driving this tool outside a run has no executor
			// to enforce anything, and saying nothing would be worse than
			// advice.
			context.adoptSkillScope?.({ skill: skill.metadata.name, allowedTools: allowed })
		}
		const notice =
			allowed === undefined
				? ''
				: `\n\n[While following this skill, restrict yourself to: ${allowed.length > 0 ? allowed.join(', ') : '(no tools)'}. This takes effect from your next turn.]`

		return {
			success: true,
			output: `${skill.body ?? '(this skill has no body)'}${notice}`,
			data: {
				skill: skill.metadata.name,
				...(allowed === undefined ? {} : { allowedTools: allowed }),
			},
		}
	},
})
