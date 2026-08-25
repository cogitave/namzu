import { createHash } from 'node:crypto'
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
	cursor: z
		.string()
		.max(160)
		.optional()
		.describe('Opaque continuation cursor returned by an earlier call for this exact skill.'),
})

type SkillInput = z.infer<typeof inputSchema>

const CURSOR_PATTERN = /^v1\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})$/

interface SkillSnapshot {
	readonly name: string
	readonly body: string
	readonly allowedTools: readonly string[] | undefined
	readonly invocation: ReturnType<typeof skillInvocation>
}

interface SkillPage {
	readonly output: string
	readonly nextCursor?: string
}

function snapshotDigest(snapshot: SkillSnapshot): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				version: 1,
				name: snapshot.name,
				body: snapshot.body,
				allowedTools: snapshot.allowedTools ?? null,
				invocation: snapshot.invocation,
			}),
		)
		.digest('base64url')
}

function cursorFor(offset: number, digest: string): string {
	return `v1.${offset}.${digest}`
}

function parseCursor(cursor: string): { offset: number; digest: string } | undefined {
	const match = CURSOR_PATTERN.exec(cursor)
	if (!match) return undefined
	const offset = Number(match[1])
	if (!Number.isSafeInteger(offset)) return undefined
	return { offset, digest: match[2] ?? '' }
}

function isCodePointBoundary(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return true
	const before = text.charCodeAt(index - 1)
	const after = text.charCodeAt(index)
	return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

function boundaryAtOrBefore(text: string, index: number): number {
	const bounded = Math.max(0, Math.min(text.length, index))
	return isCodePointBoundary(text, bounded) ? bounded : bounded - 1
}

function continuationNotice(name: string, cursor: string): string {
	return `\n\n[More skill instructions remain. Call skill again with name "${name}" and cursor "${cursor}" before acting.]`
}

function pageSkillBody(input: {
	readonly snapshot: SkillSnapshot
	readonly digest: string
	readonly start: number
	readonly notice: string
	readonly maxChars: number | undefined
}): SkillPage | undefined {
	const { snapshot, digest, start, notice, maxChars } = input
	const remaining = `${snapshot.body.slice(start)}${notice}`
	if (maxChars === undefined || maxChars <= 0 || remaining.length <= maxChars) {
		return { output: remaining }
	}

	// Estimate once, then remove exactly the overflow until the page fits.
	// The cursor grows only at powers of ten, so this converges in a handful
	// of steps without allocating an index for every character in a large file.
	let end = boundaryAtOrBefore(snapshot.body, Math.min(snapshot.body.length - 1, start + maxChars))
	while (end > start) {
		const nextCursor = cursorFor(end, digest)
		const output = `${snapshot.body.slice(start, end)}${continuationNotice(
			snapshot.name,
			nextCursor,
		)}${notice}`
		if (output.length <= maxChars) return { output, nextCursor }
		end = boundaryAtOrBefore(snapshot.body, end - Math.max(1, output.length - maxChars))
	}

	return undefined
}

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
		'Loads the instructions for a skill listed in the available-skills manifest. Long skills return an opaque continuation cursor; keep calling with that cursor until no continuation remains, before doing the work. The manifest carries only names and descriptions.',
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
		const invocation = skillInvocation(skill)
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
		const snapshot: SkillSnapshot = {
			name: input.name,
			body: skill.body ?? '(this skill has no body)',
			allowedTools: allowed,
			invocation,
		}
		const digest = snapshotDigest(snapshot)
		let start = 0
		if (input.cursor !== undefined) {
			const parsed = parseCursor(input.cursor)
			if (
				!parsed ||
				parsed.digest !== digest ||
				parsed.offset >= snapshot.body.length ||
				!isCodePointBoundary(snapshot.body, parsed.offset)
			) {
				return {
					success: false,
					output: '',
					error: `The continuation cursor for "${input.name}" is stale or invalid. Call skill again without a cursor to read the current instructions.`,
				}
			}
			start = parsed.offset
		}

		const notice =
			allowed === undefined
				? ''
				: `\n\n[While following this skill, restrict yourself to: ${allowed.length > 0 ? allowed.join(', ') : '(no tools)'}. This takes effect from your next turn.]`
		const page = pageSkillBody({
			snapshot,
			digest,
			start,
			notice,
			maxChars: context.maxToolOutputChars,
		})
		if (!page) {
			return {
				success: false,
				output: '',
				error: `The model-visible tool-output budget is too small to read "${input.name}" safely. Increase maxToolOutputChars and retry.`,
			}
		}

		// Cursor and policy validation must finish before this mutation. A
		// continuation is bound to the body AND its effective authorization
		// metadata, so an edit to allowed-tools or invocation cannot widen the
		// next batch under an old cursor.
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

		return {
			success: true,
			output: page.output,
			data: {
				skill: skill.metadata.name,
				...(allowed === undefined ? {} : { allowedTools: allowed }),
				...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			},
		}
	},
})
