import { createHash } from 'node:crypto'
import { z } from 'zod'

import { isInvocableBy, skillInvocation } from '../../types/skills/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

/**
 * Load a skill's instructions.
 *
 * The manifest in the system prompt told the model that a SKILL.md exists
 * and to "read the SKILL.md at its <location> before writing code" — which
 * is a filesystem instruction, so a turn with no filesystem tools could see
 * every skill it had and open none of them. The protocol text even admits
 * it: *"when the runtime exposes filesystem or skill-loading tools"*. There
 * was no skill-loading tool.
 *
 * **Loaded content cannot change the tool surface; only the host can.**
 * Which tools a turn may call, and how each call is authorized, are decided
 * by the host's configuration — the step's and the turn's `allowedTools`,
 * `deniedTools`, the authorization gate, the permission mode. A skill is
 * content, and may arrive in a marketplace plugin nobody on the host side
 * reviewed, so its `allowed-tools` neither narrows, widens nor pre-approves
 * anything, and the model is never told to keep to it. The loaded result
 * mentions the tools it names, for reference, and the host is warned once
 * when it names something that is not a registered tool.
 *
 * It used to narrow, twice over: the list was intersected with the step's
 * from the next batch on, and the model was told "restrict yourself to" it.
 * A skill that declared `allowed-tools: skill, read, shell, output
 * verification` — words, not tool names — then locked the rest of the turn
 * out of `bash`, `write`, `glob` and `verify_outputs` with `Tool "bash" is
 * not available on this step. Available: skill, read, shell, output
 * verification`. One author's phrasing broke the default toolset of every
 * turn that loaded the skill, and a list that can take tools away is also a
 * list that can be written to take them away. Do not reintroduce a path from
 * a loaded skill to `allowedTools`, the gate, a grant, or an instruction
 * that tells the model to narrow itself.
 */

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			'The skill to load, exactly as listed in the available-skills manifest. Omit it to list model-invocable skills.',
		),
	cursor: z
		.string()
		.max(160)
		.optional()
		.describe('Opaque continuation cursor returned by an earlier call in the same mode.'),
})

type SkillInput = z.infer<typeof inputSchema>

const CURSOR_PATTERN = /^v1\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})$/
const LIST_CURSOR_PATTERN = /^v1\.list\.(0|[1-9][0-9]*)\.([01])\.([A-Za-z0-9_-]{43})$/
const MAX_SKILLS_PER_PAGE = 20
const OVERSIZED_CATALOG_WARNING =
	'Some skills were omitted because their metadata is too large for this response budget.'

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

interface ListedSkill {
	readonly name: string
	readonly description: string
	readonly location: string
}

interface SkillListPage {
	readonly skills: readonly ListedSkill[]
	readonly warnings: readonly string[]
	readonly nextCursor: string | null
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

function listCursorFor(offset: number, warned: boolean, digest: string): string {
	return `v1.list.${offset}.${warned ? 1 : 0}.${digest}`
}

function parseListCursor(
	cursor: string,
): { offset: number; warned: boolean; digest: string } | undefined {
	const match = LIST_CURSOR_PATTERN.exec(cursor)
	if (!match) return undefined
	const offset = Number(match[1])
	if (!Number.isSafeInteger(offset)) return undefined
	return { offset, warned: match[2] === '1', digest: match[3] ?? '' }
}

function activeOutputCap(maxChars: number | undefined): number | undefined {
	return maxChars !== undefined && maxChars > 0 ? maxChars : undefined
}

function listDigest(skills: readonly ListedSkill[], maxChars: number | undefined): string {
	return createHash('sha256')
		.update(JSON.stringify({ version: 1, kind: 'list', maxChars: maxChars ?? null, skills }))
		.digest('base64url')
}

function serializeListPage(page: SkillListPage): string {
	return JSON.stringify(page)
}

function fitsListBudget(page: SkillListPage, maxChars: number | undefined): boolean {
	return maxChars === undefined || serializeListPage(page).length <= maxChars
}

function pageSkillCatalog(input: {
	readonly skills: readonly ListedSkill[]
	readonly digest: string
	readonly start: number
	readonly warningAlreadyShown: boolean
	readonly maxChars: number | undefined
}): SkillListPage | undefined {
	const { skills, digest, start, warningAlreadyShown, maxChars } = input
	const retained: Array<{ index: number; skill: ListedSkill }> = []
	let omitted = false
	let hasRetainedLater = false

	// Work backwards so the final retained entry is tested without a cursor.
	// A last entry that fits by itself must not be dropped merely because an
	// earlier page will need a continuation token to reach it.
	for (let index = skills.length - 1; index >= start; index -= 1) {
		const skill = skills[index]
		if (!skill) continue
		const nextCursor = hasRetainedLater ? listCursorFor(index + 1, true, digest) : null
		if (fitsListBudget({ skills: [skill], warnings: [], nextCursor }, maxChars)) {
			retained.push({ index, skill })
			hasRetainedLater = true
		} else {
			omitted = true
		}
	}
	retained.reverse()

	const warning = omitted && !warningAlreadyShown ? [OVERSIZED_CATALOG_WARNING] : []
	let count = Math.min(MAX_SKILLS_PER_PAGE, retained.length)
	while (count > 0) {
		const selected = retained.slice(0, count)
		const last = selected.at(-1)
		const hasMore = count < retained.length
		const page: SkillListPage = {
			skills: selected.map((entry) => entry.skill),
			warnings: warning,
			nextCursor:
				hasMore && last
					? listCursorFor(last.index + 1, warningAlreadyShown || warning.length > 0, digest)
					: null,
		}
		if (fitsListBudget(page, maxChars)) return page
		count -= 1
	}

	if (warning.length > 0) {
		const page: SkillListPage = {
			skills: [],
			warnings: warning,
			nextCursor: retained.length > 0 ? listCursorFor(start, true, digest) : null,
		}
		if (fitsListBudget(page, maxChars)) return page
	}

	const empty: SkillListPage = { skills: [], warnings: [], nextCursor: null }
	return retained.length === 0 && fitsListBudget(empty, maxChars) ? empty : undefined
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
 * `allowed-tools` as the list of entries its author wrote.
 *
 * Both spellings in use are accepted. A declaration with a comma outside
 * parentheses is split on commas only (`Read, Grep`), so an entry written in
 * words — `output verification` — stays one entry and is reported as one.
 * Otherwise whitespace separates, the agentskills.io form (`Bash(git:*)
 * Read`). Parentheses group either way, `Bash(git add:*)` being one entry,
 * but only when they balance: an unclosed `(` would otherwise swallow every
 * entry after it, and a name that silently vanishes is one its author is
 * never told is not a tool.
 *
 * Split here rather than at parse so the stored metadata keeps the author's
 * own string — the same reasoning `invocation` uses for not defaulting at
 * parse. `undefined` means the skill declared nothing and `[]` that it
 * declared an empty list; neither changes what a turn may call.
 */
export function parseAllowedTools(declared: string | undefined): readonly string[] | undefined {
	if (declared === undefined) return undefined
	const grouping = parenthesesBalance(declared)
	const byComma = splitAtTopLevel(declared, grouping, (char) => char === ',').length > 1
	return splitAtTopLevel(declared, grouping, byComma ? (char) => char === ',' : isWhitespace)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

function isWhitespace(char: string): boolean {
	return /\s/.test(char)
}

function parenthesesBalance(value: string): boolean {
	let depth = 0
	for (const char of value) {
		if (char === '(') depth += 1
		else if (char === ')') {
			depth -= 1
			if (depth < 0) return false
		}
	}
	return depth === 0
}

function splitAtTopLevel(
	value: string,
	grouping: boolean,
	separates: (char: string) => boolean,
): string[] {
	const parts: string[] = []
	let depth = 0
	let current = ''
	for (const char of value) {
		if (grouping && char === '(') depth += 1
		else if (grouping && char === ')') depth -= 1
		if (depth === 0 && separates(char)) {
			parts.push(current)
			current = ''
		} else {
			current += char
		}
	}
	parts.push(current)
	return parts
}

/** `Name` or `Name(pattern)`, and nothing after the closing parenthesis. */
const DECLARED_ENTRY = /^([^()]+?)\s*(?:\(.*\))?$/s

/**
 * The tool an entry names, or `undefined` for an entry that is not shaped
 * like one.
 *
 * `Bash(git:*)` scopes a tool to a command pattern in the formats this field
 * comes from. There is no pattern to honour here — the list grants nothing —
 * so the pattern is dropped and the entry names `Bash`. Anything else with
 * a parenthesis in it (`Bash(git:*)Read`, an unclosed `Bash(git:*`) names no
 * tool, so it is reported as written rather than read as the tool before
 * the `(` with the rest thrown away.
 */
function declaredToolName(entry: string): string | undefined {
	const match = DECLARED_ENTRY.exec(entry)
	const name = match?.[1]?.trim()
	return name === undefined || name.length === 0 ? undefined : name
}

interface DeclaredTools {
	/** Tools this turn can call that the declaration mentions, in its order, once each. */
	readonly named: readonly string[]
	/** Entries, as the author wrote them, that this turn cannot call. */
	readonly unavailable: readonly string[]
	/** Entries that match no registered tool at all. For the host's log only. */
	readonly unknown: readonly string[]
}

/** `name` as one of `names` spells it: exactly, else ignoring case. */
function matchName(name: string, names: readonly string[]): string | undefined {
	if (names.includes(name)) return name
	const folded = name.toLowerCase()
	return names.find((candidate) => candidate.toLowerCase() === folded)
}

/**
 * Match a declaration against the tools this turn holds.
 *
 * An exact name first, then the same name ignoring case, so `Read` finds
 * `read`. What the MODEL is told is split by what this turn can call: a
 * registered tool the turn's list withholds, or one that is suspended, reads
 * the same as one that does not exist — the rule `search_tools` keeps for
 * its no-match answer — so the mention cannot become a way to learn what
 * lies outside the turn's scope. The HOST's warning is about the registry,
 * because the author's mistake is a name that is no tool anywhere.
 *
 * Without a registry that can list its names there is nothing to check
 * against; entries are matched against the turn's list if it has one, and
 * otherwise passed through by name.
 */
function resolveDeclaredTools(
	declared: readonly string[],
	registry: ToolContext['toolRegistry'],
	allowed: readonly string[] | undefined,
): DeclaredTools {
	const registered = registry?.listNames?.()
	const named = new Set<string>()
	const unavailable = new Set<string>()
	const unknown = new Set<string>()
	for (const entry of declared) {
		const name = declaredToolName(entry)
		const canonical =
			name === undefined
				? undefined
				: registered !== undefined
					? matchName(name, registered)
					: allowed !== undefined
						? matchName(name, allowed)
						: name
		if (registered !== undefined && canonical === undefined) unknown.add(entry)
		const callable =
			canonical !== undefined &&
			(allowed === undefined || allowed.includes(canonical)) &&
			(registered === undefined || registry?.getAvailability(canonical) !== 'suspended')
		if (callable) named.add(canonical)
		else unavailable.add(entry)
	}
	return { named: [...named], unavailable: [...unavailable], unknown: [...unknown] }
}

/**
 * What the model is told about a declaration: which tools it mentions, and
 * nothing it should do about them. Nothing at all for an empty one.
 */
function declaredToolsHint(tools: DeclaredTools): string {
	if (tools.named.length === 0 && tools.unavailable.length === 0) return ''
	const parts: string[] = []
	if (tools.named.length > 0) {
		parts.push(`Tools this skill mentions: ${tools.named.join(', ')}.`)
	}
	if (tools.unavailable.length > 0) {
		parts.push(
			`${tools.named.length > 0 ? 'It also mentions' : 'It mentions'} ${tools.unavailable.map((entry) => JSON.stringify(entry)).join(', ')}, which ${tools.unavailable.length === 1 ? 'is' : 'are'} not available here.`,
		)
	}
	parts.push(
		'For reference only: loading a skill does not change which tools you can call or how their calls are approved.',
	)
	return `\n\n[${parts.join(' ')}]`
}

/**
 * Declarations already warned about, per tool registry.
 *
 * Once per registry rather than per call: a paged body resolves the list
 * again on every page and a model may load the same skill twice, and the
 * author needs the line once. A host that keeps one registry for a whole
 * session is therefore warned once per session. Keyed weakly so a registry
 * that is gone takes its entries with it.
 */
const warnedDeclarations = new WeakMap<object, Set<string>>()

function warnUnknownToolsOnce(
	context: ToolContext,
	skill: string,
	unknown: readonly string[],
): void {
	const registry = context.toolRegistry
	if (unknown.length === 0 || registry === undefined) return
	let warned = warnedDeclarations.get(registry)
	if (warned === undefined) {
		warned = new Set()
		warnedDeclarations.set(registry, warned)
	}
	const key = JSON.stringify([skill, unknown])
	if (warned.has(key)) return
	warned.add(key)
	context.log(
		'warn',
		`Skill ${JSON.stringify(skill)} lists allowed-tools that match no registered tool: ${unknown.map((entry) => JSON.stringify(entry)).join(', ')}. The list is advisory and changes no tool's availability or approval; name registered tools for the mention to be of use.`,
	)
}

export const SKILL_TOOL_NAME = 'skill'

export const SkillTool = defineTool({
	name: SKILL_TOOL_NAME,
	description:
		'Lists model-invocable skills when called without a name, or loads one skill by its exact listed name. Long lists and bodies return an opaque continuation cursor; keep calling in the same mode with that cursor until no continuation remains. The manifest carries only names and descriptions.',
	inputSchema,
	category: 'analysis',
	permissions: [],
	// Reads instructions and changes nothing — the turn's tool surface
	// included. See the note at the top of this file.
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input: SkillInput, context) {
		if (!context.skills) {
			return {
				success: false,
				output: '',
				error:
					'This turn has no skills registry, so there is nothing to load. Proceed without the skill.',
			}
		}

		if (input.name === undefined) {
			if (!context.skills.catalog) {
				return {
					success: false,
					output: '',
					error:
						'This skills registry cannot enumerate model-safe metadata. Use a skill name from the available-skills manifest.',
				}
			}
			const skills = (await context.skills.catalog())
				.filter(
					(entry) =>
						entry.invocation === undefined ||
						entry.invocation === 'model' ||
						entry.invocation === 'both',
				)
				.map(
					(entry): ListedSkill => ({
						name: entry.registeredName,
						description: entry.description,
						location: entry.location,
						// Not `allowedTools`: a listing field named for permission reads
						// as one. The load result mentions the tools a skill names.
					}),
				)
			const maxChars = activeOutputCap(context.maxToolOutputChars)
			const digest = listDigest(skills, maxChars)
			let start = 0
			let warningAlreadyShown = false
			if (input.cursor !== undefined) {
				const parsed = parseListCursor(input.cursor)
				if (!parsed || parsed.digest !== digest || parsed.offset >= skills.length) {
					return {
						success: false,
						output: '',
						error:
							'The skill-list continuation cursor is stale or invalid. Call skill again without a cursor to read the current catalog.',
					}
				}
				start = parsed.offset
				warningAlreadyShown = parsed.warned
			}

			const page = pageSkillCatalog({
				skills,
				digest,
				start,
				warningAlreadyShown,
				maxChars,
			})
			if (!page) {
				return {
					success: false,
					output: '',
					error:
						'The model-visible tool-output budget is too small to list skill metadata safely. Increase maxToolOutputChars and retry.',
				}
			}

			return {
				success: true,
				output: serializeListPage(page),
				data: {
					kind: 'list',
					count: page.skills.length,
					...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
				},
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

		const declared =
			allowed === undefined
				? undefined
				: resolveDeclaredTools(allowed, context.toolRegistry, context.allowedTools)
		const notice = declared === undefined ? '' : declaredToolsHint(declared)
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

		// A continuation is bound to the body, the declared tool list and the
		// invocation, so an edit to any of them restarts the read rather than
		// continuing it under a cursor minted for different content.
		//
		// Nothing is adopted. The list is mentioned and, where it names no
		// registered tool, warned about under the name the registry accepts;
		// the turn's tool surface is the host's, and this call leaves it as it
		// found it.
		if (declared !== undefined) {
			warnUnknownToolsOnce(context, input.name, declared.unknown)
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
