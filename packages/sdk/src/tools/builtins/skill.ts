import { createHash } from 'node:crypto'
import { z } from 'zod'

import { parseAllowedTools } from '../../authorization/skill-grant.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import { isInvocableBy, skillInvocation } from '../../types/skills/index.js'
import { defineTool } from '../defineTool.js'

export { parseAllowedTools }

/**
 * Load a skill's instructions, and apply what its `allowed-tools` grants.
 *
 * The manifest in the system prompt told the model that a SKILL.md exists
 * and to "read the SKILL.md at its <location> before writing code" — which
 * is a filesystem instruction, so a turn with no filesystem tools could see
 * every skill it had and open none of them. There was no skill-loading tool.
 *
 * `allowed-tools` is a PRE-APPROVAL, as the Agent Skills format defines it:
 * the listed tools skip the approval prompt for the rest of this turn, and
 * every other tool stays callable under the turn's ordinary review. It was
 * read here for a while as a restriction — the listed tools and nothing
 * else, from the next batch — which inverted what skill authors mean by it
 * and left a model that loaded `allowed-tools: Read Grep` without `bash`.
 * See `authorization/skill-grant.ts` for what a grant can and cannot do.
 *
 * A skill's body often names files beside it (`scripts/`, `references/`,
 * `assets/`), and the load result carried no directory to open them from. The
 * listing reported the registry's `location`, which is where the HOST reads
 * the skill — a path the model cannot open once its tools run in a sandbox or
 * a remote workspace, so it hard-coded what the skill said to read, or went
 * searching the filesystem. Only the host knows what its tools can reach, so
 * the host says it: {@link SkillToolOptions.resolveModelDirectory}.
 */

/** One skill, as the `skill` tool asks a host about it. */
export interface SkillDirectoryRequest {
	/** The name the registry accepts, namespaced for a plugin skill (`plugin__skill`). */
	readonly name: string
	/**
	 * Where the host loads the skill from (`Skill.dirPath`, or the catalog
	 * entry's `directory`); undefined when the registry does not say.
	 */
	readonly directory: string | undefined
}

/** What the call knows about where the model's tools run. */
export interface SkillDirectoryContext {
	/** The turn's sandbox, when its tools run in one. Absent on the host. */
	readonly sandbox?: Sandbox
}

/**
 * The directory the model's tools can open for a skill, or undefined when
 * they cannot reach it.
 *
 * Asked per call, with the turn's sandbox, because the answer is a property
 * of where the tools run and not of the skill: the same skill is at its own
 * path on the host, somewhere else inside a container, and absent from a
 * sandbox that does not mount it.
 */
export type SkillDirectoryResolver = (
	skill: SkillDirectoryRequest,
	context: SkillDirectoryContext,
) => string | undefined | Promise<string | undefined>

export interface SkillToolOptions {
	/**
	 * Say which directory the model can open for each skill.
	 *
	 * Absent, the tool behaves as it always has: the listing carries the
	 * registry's `location` and a load names no directory. Present, a load
	 * opens with the directory it returns, or with a line saying the skill's
	 * files are not reachable when it returns undefined; the listing carries
	 * that `directory` and never the registry's `location`, which is the
	 * host's path; and `${CLAUDE_SKILL_DIR}` in `allowed-tools` expands to it,
	 * since a command line the model writes names the path the model was
	 * given. The skill is still LOADED from the registry's own path.
	 */
	readonly resolveModelDirectory?: SkillDirectoryResolver
}

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
	/** Bound into the cursor because `${CLAUDE_SKILL_DIR}` in a grant expands to it. */
	readonly skillDirectory: string | undefined
	/** What the first page opens with: where the skill's files are, or that they are out of reach. */
	readonly header: string
	readonly invocation: ReturnType<typeof skillInvocation>
}

interface SkillPage {
	readonly output: string
	readonly nextCursor?: string
}

interface ListedSkill {
	readonly name: string
	readonly description: string
	/** The registry's path to the SKILL.md; only when no host resolver is configured. */
	readonly location?: string
	/** The directory the model can open, from the host's resolver. */
	readonly directory?: string
	readonly allowedTools?: string
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
				...(snapshot.skillDirectory === undefined
					? {}
					: { skillDirectory: snapshot.skillDirectory }),
				...(snapshot.header === '' ? {} : { header: snapshot.header }),
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
	// The first page only: a continuation is read after it, in the same history.
	const header = start === 0 ? snapshot.header : ''
	const remaining = `${header}${snapshot.body.slice(start)}${notice}`
	if (maxChars === undefined || maxChars <= 0 || remaining.length <= maxChars) {
		return { output: remaining }
	}

	// Estimate once, then remove exactly the overflow until the page fits.
	// The cursor grows only at powers of ten, so this converges in a handful
	// of steps without allocating an index for every character in a large file.
	let end = boundaryAtOrBefore(snapshot.body, Math.min(snapshot.body.length - 1, start + maxChars))
	while (end > start) {
		const nextCursor = cursorFor(end, digest)
		const output = `${header}${snapshot.body.slice(start, end)}${continuationNotice(
			snapshot.name,
			nextCursor,
		)}${notice}`
		if (output.length <= maxChars) return { output, nextCursor }
		end = boundaryAtOrBefore(snapshot.body, end - Math.max(1, output.length - maxChars))
	}

	return undefined
}

export const SKILL_TOOL_NAME = 'skill'

/**
 * Build the `skill` tool, with what the host knows about where its model's
 * tools run. {@link SkillTool} is this with no options.
 */
export function createSkillTool(options: SkillToolOptions = {}) {
	const resolveModelDirectory = options.resolveModelDirectory
	return defineTool({
		name: SKILL_TOOL_NAME,
		description:
			'Lists model-invocable skills when called without a name, or loads one skill by its exact listed name. Long lists and bodies return an opaque continuation cursor; keep calling in the same mode with that cursor until no continuation remains. The manifest carries only names and descriptions.',
		inputSchema,
		category: 'analysis',
		permissions: [],
		// Reads instructions and changes nothing on disk. What it does change is
		// the turn's approvals, through `grantSkillTools`, and only ever towards
		// fewer prompts for calls the operator's policy already leaves to review.
		readOnly: true,
		destructive: false,
		concurrencySafe: true,

		// The body is instructions for the model, often a hundred lines; the
		// person needs the row that says which skill was read, not the text.
		presentCall(input: SkillInput) {
			const name = typeof input?.name === 'string' ? input.name : undefined
			return {
				kind: 'generic',
				presentation: 'activity',
				label:
					name === undefined
						? input?.cursor === undefined
							? 'List skills'
							: 'List more skills'
						: `Read skill ${name}${input.cursor === undefined ? '' : ' (continued)'}`,
			}
		},
		presentResult: (_input: SkillInput, result) =>
			result.success ? { kind: 'generic', label: 'read', visibility: 'hidden' } : undefined,

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
				const directoryContext = directoryContextOf(context.sandbox)
				const skills = await Promise.all(
					(await context.skills.catalog())
						.filter(
							(entry) =>
								entry.invocation === undefined ||
								entry.invocation === 'model' ||
								entry.invocation === 'both',
						)
						.map(async (entry): Promise<ListedSkill> => {
							// With a resolver the registry's `location` is left out, not
							// shown beside the directory: it is the host's path, the one
							// a sandboxed model cannot open.
							let where: Pick<ListedSkill, 'location' | 'directory'>
							if (resolveModelDirectory) {
								const directory = nonEmpty(
									await resolveModelDirectory(
										{ name: entry.registeredName, directory: entry.directory },
										directoryContext,
									),
								)
								where = directory === undefined ? {} : { directory }
							} else {
								where = { location: entry.location }
							}
							return {
								name: entry.registeredName,
								description: entry.description,
								...where,
								...(entry.allowedTools === undefined ? {} : { allowedTools: entry.allowedTools }),
							}
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
			// Asked on every call, first page or continuation: the digest binds
			// the answer, so a mount that changed between pages is a stale cursor
			// rather than a second half written for a different directory.
			const modelDirectory = resolveModelDirectory
				? nonEmpty(
						await resolveModelDirectory(
							{ name: input.name, directory: skill.dirPath },
							directoryContextOf(context.sandbox),
						),
					)
				: undefined
			const snapshot: SkillSnapshot = {
				name: input.name,
				body: skill.body ?? '(this skill has no body)',
				allowedTools: allowed,
				// The model's path when the host gave one: `${CLAUDE_SKILL_DIR}` in a
				// pattern is matched against a command line the model writes, and it
				// writes the path it was told.
				skillDirectory: resolveModelDirectory ? modelDirectory : skill.dirPath,
				header: resolveModelDirectory ? directoryHeader(modelDirectory) : '',
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

			// Compiled before paging so the notice can say what the grant is, and
			// committed only after paging succeeded: a load that fails here gave
			// the model no instructions, so it must not have approved anything.
			// Idempotent: a continuation call grants the same entries again, and
			// the turn's set keeps one copy.
			let grant: ReturnType<NonNullable<typeof context.grantSkillTools>> | undefined
			if (allowed !== undefined && allowed.length > 0 && context.grantSkillTools) {
				grant = context.grantSkillTools({
					skill: skill.metadata.name,
					allowedTools: allowed,
					...(snapshot.skillDirectory ? { skillDirectory: snapshot.skillDirectory } : {}),
				})
			}
			const notice = grantNotice(allowed, grant, context.grantSkillTools !== undefined)
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
			grant?.commit()

			return {
				success: true,
				output: page.output,
				data: {
					skill: skill.metadata.name,
					...(modelDirectory === undefined ? {} : { directory: modelDirectory }),
					...(allowed === undefined ? {} : { allowedTools: allowed }),
					...(grant ? { granted: grant.granted, ignored: grant.ignored } : {}),
					...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
				},
			}
		},
	})
}

/** The `skill` tool with no host options: the listing carries the registry's `location`. */
export const SkillTool = createSkillTool()

function directoryContextOf(sandbox: Sandbox | undefined): SkillDirectoryContext {
	return sandbox ? { sandbox } : {}
}

/** An empty string names no directory; treated as the resolver saying none. */
function nonEmpty(directory: string | undefined): string | undefined {
	return directory === undefined || directory === '' ? undefined : directory
}

/**
 * The line a load opens with once a host has said where the skill's files are.
 *
 * The unreachable case is said out loud rather than left blank. A model given
 * no directory for a skill that says "run scripts/render.sh" goes looking for
 * it, and on a sandboxed turn that search can only fail.
 */
function directoryHeader(directory: string | undefined): string {
	return directory === undefined
		? "[This skill's directory is not reachable from your tools in this session, so a file these instructions name by a relative path (scripts/, references/, assets/) cannot be opened here. Do not search the filesystem for it; if the task needs one, say so.]\n\n"
		: `[Skill directory: ${directory}. Relative paths in these instructions, such as scripts/, references/ or assets/, are inside it.]\n\n`
}

/**
 * What the model is told about `allowed-tools`.
 *
 * The sentence that matters most is the second one. The old notice said
 * "restrict yourself to", and a model told that does exactly what the owner
 * reported: it stops using `bash` and tries to do the work through the skill.
 * So the notice says, every time, that nothing was taken away.
 */
function grantNotice(
	allowed: readonly string[] | undefined,
	grant:
		| {
				granted: readonly string[]
				ignored: readonly { entry: string; reason: string }[]
		  }
		| undefined,
	canGrant: boolean,
): string {
	if (allowed === undefined || allowed.length === 0) return ''
	const unchanged =
		'Every other tool remains available and is reviewed as usual; this skill does not limit which tools you may use.'
	if (!canGrant || !grant) {
		return `\n\n[This skill lists allowed-tools (${allowed.join(', ')}), but this host applies no pre-approval, so those calls are reviewed as usual. ${unchanged}]`
	}
	const lines: string[] = []
	lines.push(
		grant.granted.length > 0
			? `Pre-approved for the rest of this turn: ${grant.granted.join(', ')}. Deny and ask rules, plan and strict mode, and review of destructive calls still apply.`
			: 'Nothing in allowed-tools could be pre-approved.',
	)
	for (const { entry, reason } of grant.ignored) {
		lines.push(`Ignored allowed-tools entry "${entry}": ${reason}.`)
	}
	lines.push(unchanged)
	return `\n\n[${lines.join(' ')}]`
}
