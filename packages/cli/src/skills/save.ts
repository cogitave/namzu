/**
 * `save_skill`: the model proposes a `SKILL.md`, the operator decides.
 *
 * The tool exists only in the interactive TUI (the App hands it to its own
 * session through `extraTools`; `exec`, `drain`, a scheduled run and every
 * sub-agent build their registries without it). Nothing is written until a
 * person picks a target on a screen drawn from what this module computes —
 * the exact file, with invisible characters shown, where it would go, and
 * which existing skill it would replace or be hidden by. That question is
 * the host's own (`SaveSkillHost.confirm`), not the permission gate's, so no
 * permission mode answers it: `auto` still asks.
 *
 * A saved skill is a single `SKILL.md`, written atomically (a temporary
 * beside it, then `rename`). The session catalog discovers again every turn,
 * so the model is offered it from the next turn on.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
	type ToolDefinition,
	type ToolResult,
	defineTool,
	mcpJsonSchemaToZod,
	revealHiddenCharacters,
	scanSchedulePrompt,
} from '@namzu/sdk'

import type { SkillsConfig } from '../config/schema.js'
import {
	SKILL_TIERS,
	type SkillTier,
	discoverSkillRoster,
	parseSkillMarkdown,
	projectSkillsDir,
	skillTierLabel,
	userSkillsDir,
} from './store.js'

export const SAVE_SKILL_TOOL_NAME = 'save_skill'

/** The built-in skill that interviews the operator and drafts a skill. */
export const SKILL_CREATOR_SKILL = 'skill-creator'

/** What `/skills new [idea]` sends as the operator's prompt. */
export function newSkillPrompt(idea: string): string {
	const what = idea.trim()
	return [
		`Help me create a new skill. Load the ${SKILL_CREATOR_SKILL} skill with the skill tool and follow it: interview me, show me the draft, and save it with save_skill only after I agree. Write the skill in the language of my own messages, not in English by default (namzu writes this request in English; it does not count).`,
		what ? `What the skill should do: ${what}` : 'Start by asking what the skill should do.',
	].join(' ')
}

/**
 * What `/skills save [name]` sends: one turn, in the conversation whose work
 * it saves, that ends on the `save_skill` screen. The screen shows the whole
 * file and saves nothing until the operator picks a place, so the model is
 * told to go straight to it rather than ask in a reply first.
 */
export function learnSkillPrompt(name?: string): string {
	return [
		`Save what we just did in this conversation as a reusable skill. Load the ${SKILL_CREATOR_SKILL} skill with the skill tool and follow its "from this conversation" mode: generalise the task, replace this run's names, paths, values and dates with placeholders, leave out secrets and personal data, and never copy tool, file or page output into it.`,
		name
			? `Name it ${name}.`
			: 'Choose a short name for the kind of task, not for this instance of it.',
		'Write the description and instructions in the language of my own earlier messages in this conversation, not in English by default (namzu writes this request in English; it does not count). The name stays lowercase ASCII with dashes.',
		'The save_skill confirmation screen is my review of the draft: call save_skill with origin "learned" in this turn, without asking me in a reply first. If I cancel, ask what to change.',
	].join(' ')
}

/** The kernel loader's own limits, checked here so the operator is never shown a file it would refuse. */
export const SKILL_NAME_MAX_CHARS = 64
export const SKILL_DESCRIPTION_MAX_CHARS = 1024
/** A skill body is instructions, not a document store. */
export const SKILL_BODY_MAX_BYTES = 64 * 1024

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillSaveScope = 'user' | 'project'
export type SkillOrigin = 'created' | 'learned'

/** What the model proposed, after validation. */
export interface SkillDraft {
	readonly name: string
	readonly description: string
	readonly body: string
	readonly origin: SkillOrigin
}

/** Another `SKILL.md` of the same name, and what saving here does to it. */
export interface SkillCollision {
	/**
	 * `replaces`: the new file takes its place — the same path (overwritten)
	 * or a lower tier (shadowed). `hidden-by`: a higher tier's file keeps
	 * winning, so the saved skill would not be the one used.
	 */
	readonly effect: 'replaces' | 'hidden-by'
	/** The existing file's tier in the operator's words (`built-in`, `~/.namzu/skills`, …). */
	readonly where: string
	readonly path: string
	/** True when it is the very file this save would overwrite. */
	readonly overwrite: boolean
}

export interface SkillSaveTarget {
	readonly scope: SkillSaveScope
	/** The `SKILL.md` this choice writes. */
	readonly path: string
	/** The same path as the operator would type it (`~/…`, `./…`). */
	readonly displayPath: string
	readonly collisions: readonly SkillCollision[]
}

/** Everything the confirmation shows. Computed by the host, never taken from the model's words. */
export interface SaveSkillRequest {
	readonly draft: SkillDraft
	/** The file exactly as it would be written. */
	readonly markdown: string
	/** `markdown` with invisible and control characters shown as `<U+XXXX>`. */
	readonly revealed: string
	readonly targets: { readonly user: SkillSaveTarget; readonly project: SkillSaveTarget }
	/** Where the model suggested it go; the screen marks it, nothing preselects it. */
	readonly suggested: SkillSaveScope
	/** The conversation it came from, when there is one. */
	readonly sessionId?: string
	/** Hidden characters, instructions to ignore instructions, secrets, exfiltration. */
	readonly warnings: readonly string[]
}

export type SaveSkillAnswer = SkillSaveScope | 'cancel'

export interface SaveSkillHost {
	/** The session's working directory: the project tier is `<cwd>/.namzu/skills`. */
	readonly cwd: () => string
	/** The operator's home directory. Absent: `NAMZU_HOME` and the OS home, as discovery reads them. */
	readonly home?: () => string | undefined
	readonly config?: () => SkillsConfig | undefined
	readonly sessionId: () => string | undefined
	/**
	 * Ask the person. Anything but `user` or `project` — `cancel`, a thrown
	 * error, an aborted turn — writes nothing.
	 */
	readonly confirm: (request: SaveSkillRequest, signal?: AbortSignal) => Promise<SaveSkillAnswer>
	/** Told after a file was written. */
	readonly saved?: (result: { readonly name: string; readonly path: string }) => void
	/** The clock, for `namzu-created`. */
	readonly now?: () => Date
}

export class SkillDraftError extends Error {
	override readonly name = 'SkillDraftError'
}

/**
 * Normalise and check what the model proposed. Throws {@link SkillDraftError}
 * naming the first problem.
 */
export function validateSkillDraft(input: {
	readonly name: string
	readonly description: string
	readonly body: string
	readonly origin?: SkillOrigin
}): SkillDraft {
	const name = input.name.trim()
	if (name.length === 0 || name.length > SKILL_NAME_MAX_CHARS || !SKILL_NAME_PATTERN.test(name)) {
		throw new SkillDraftError(
			`name "${name}" must be 1–${SKILL_NAME_MAX_CHARS} lowercase letters, digits and single hyphens (like "release-notes").`,
		)
	}
	// One line: the frontmatter holds a single-line value, and a description
	// is read by the model as one sentence or two anyway.
	const description = input.description.replace(/\s+/g, ' ').trim()
	if (description.length === 0) throw new SkillDraftError('description must not be empty.')
	if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
		throw new SkillDraftError(
			`description is ${description.length} characters; at most ${SKILL_DESCRIPTION_MAX_CHARS}.`,
		)
	}
	const body = input.body.replace(/\r\n?/g, '\n').trim()
	if (body.length === 0) throw new SkillDraftError('body must not be empty.')
	const bytes = Buffer.byteLength(body, 'utf8')
	if (bytes > SKILL_BODY_MAX_BYTES) {
		throw new SkillDraftError(`body is ${bytes} bytes; at most ${SKILL_BODY_MAX_BYTES}.`)
	}
	if (/^---[ \t]*$/m.test(body.split('\n', 1)[0] ?? '')) {
		throw new SkillDraftError(
			'body must be the instructions only; pass name and description as fields, not as frontmatter.',
		)
	}
	return { name, description, body, origin: input.origin ?? 'created' }
}

/** The `SKILL.md` for a draft. Round-tripped through the reader before anyone sees it. */
export function composeSkillMarkdown(
	draft: SkillDraft,
	meta: { readonly sessionId?: string; readonly createdAt: Date },
): string {
	const lines = [
		'---',
		`name: ${draft.name}`,
		`description: "${draft.description}"`,
		'metadata:',
		`  namzu-origin: ${draft.origin}`,
		...(meta.sessionId ? [`  namzu-session: "${meta.sessionId}"`] : []),
		`  namzu-created: "${meta.createdAt.toISOString()}"`,
		'---',
		'',
		draft.body,
		'',
	]
	const markdown = lines.join('\n')
	let parsed: ReturnType<typeof parseSkillMarkdown>
	try {
		parsed = parseSkillMarkdown(markdown)
	} catch (error) {
		throw new SkillDraftError(
			`the file would not load: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (parsed.name !== draft.name || parsed.description !== draft.description) {
		throw new SkillDraftError(
			'the description would read back differently from what was written; drop leading or trailing quotes and brackets.',
		)
	}
	return markdown
}

function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path)
	if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return `./${rel.split(sep).join('/')}`
	const home = homedir()
	const fromHome = relative(home, path)
	if (fromHome && !fromHome.startsWith('..')) return `~/${fromHome.split(sep).join('/')}`
	return path
}

/** Where each choice writes, and what already holds that name. */
export function planSkillTargets(
	name: string,
	options: { readonly cwd: string; readonly home?: string; readonly config?: SkillsConfig },
): { readonly user: SkillSaveTarget; readonly project: SkillSaveTarget } {
	const roster = discoverSkillRoster({
		cwd: options.cwd,
		...(options.home !== undefined ? { home: options.home } : {}),
		// Every tier, the built-in one included even when the config turns it
		// off: "replaces" is about files, and the file is there.
		config: { ...(options.config ?? {}), builtin: true, disabled: [] },
	})
	const existing = [
		...roster.skills.filter((skill) => skill.name === name),
		...roster.shadowed.filter((skill) => skill.name === name),
	]
	const target = (scope: SkillSaveScope): SkillSaveTarget => {
		const tier: SkillTier = scope
		const dir = scope === 'user' ? userSkillsDir(options.home) : projectSkillsDir(options.cwd)
		const path = join(dir, name, 'SKILL.md')
		const rank = SKILL_TIERS.indexOf(tier)
		const collisions = existing
			.map((skill): SkillCollision => {
				const overwrite = skill.path === path
				const higher = !overwrite && SKILL_TIERS.indexOf(skill.tier) > rank
				return {
					effect: higher ? 'hidden-by' : 'replaces',
					where: skillTierLabel(skill.tier),
					path: skill.path,
					overwrite,
				}
			})
			.sort((a, b) => Number(b.overwrite) - Number(a.overwrite))
		return { scope, path, displayPath: displayPath(path, options.cwd), collisions }
	}
	return { user: target('user'), project: target('project') }
}

/** One line per collision, as the confirmation and the tool result say it. */
export function describeCollision(collision: SkillCollision, cwd: string): string {
	const where = displayPath(collision.path, cwd)
	if (collision.overwrite) return `replaces ${collision.where} skill ${where} (overwrites it)`
	return collision.effect === 'replaces'
		? `replaces ${collision.where} skill ${where}`
		: `hidden by ${collision.where} skill ${where}, which keeps winning`
}

/** The prompt tripwire, worded for a skill. */
export function skillWarnings(markdown: string): string[] {
	return scanSchedulePrompt(markdown).map((finding) => finding.replace(/^The prompt/, 'The skill'))
}

/**
 * Write `text` to `path` so a reader sees the old file or the new one, never
 * part of either: a temporary beside it, flushed, then renamed over it.
 */
export function writeFileAtomically(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const temporary = join(
		dirname(path),
		`.SKILL.md.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
	)
	try {
		const fd = openSync(temporary, 'wx', 0o644)
		try {
			writeSync(fd, text)
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
		renameSync(temporary, path)
	} catch (error) {
		rmSync(temporary, { force: true })
		throw error
	}
}

const inputSchema = mcpJsonSchemaToZod({
	type: 'object',
	properties: {
		name: {
			type: 'string',
			minLength: 1,
			maxLength: 128,
			description:
				'Directory and skill name: lowercase letters, digits and single hyphens, at most 64.',
		},
		description: {
			type: 'string',
			minLength: 1,
			maxLength: 4096,
			description:
				'One or two sentences saying WHEN to use the skill (the task and the words a user would use), at most 1024 characters. The model decides to load a skill from this alone.',
		},
		body: {
			type: 'string',
			minLength: 1,
			maxLength: 200_000,
			description: 'The instructions: markdown, no frontmatter. Steps, constraints, examples.',
		},
		scope: {
			type: 'string',
			enum: ['user', 'project'],
			description:
				'Where you suggest it go: user (~/.namzu/skills, every project) or project (./.namzu/skills). The operator chooses.',
		},
		replaces: {
			type: 'string',
			description: 'The name of the existing skill this updates, when it is one. Must equal name.',
		},
		origin: {
			type: 'string',
			enum: ['created', 'learned'],
			description:
				'created: written with the operator; learned: generalised from this conversation.',
		},
	},
	required: ['name', 'description', 'body'],
	additionalProperties: false,
})

interface Input {
	readonly name: string
	readonly description: string
	readonly body: string
	readonly scope?: SkillSaveScope
	readonly replaces?: string
	readonly origin?: SkillOrigin
}

function refuse(error: string): ToolResult {
	return { success: false, output: '', error }
}

/**
 * The `save_skill` tool over a {@link SaveSkillHost}. Register it only where a
 * person is present to confirm — the interactive TUI's own session.
 */
export function buildSaveSkillTool(host: SaveSkillHost): ToolDefinition {
	return defineTool({
		name: SAVE_SKILL_TOOL_NAME,
		description:
			'Propose a reusable skill (a SKILL.md: name, description, instructions) for the operator to save. The operator sees the whole file and where it would go, and picks user, project or cancel; nothing is written without that. Use it only when the operator asked for a skill (the skill-creator skill describes how to draft one).',
		inputSchema,
		category: 'custom',
		permissions: ['file_write'],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		// A person reads the whole file before answering; the default two
		// minutes would close the question on them.
		timeoutMs: 30 * 60_000,
		presentCall: (input) => ({
			kind: 'generic',
			label:
				`Propose skill ${typeof (input as Partial<Input>).name === 'string' ? (input as Input).name : ''}`.trim(),
			presentation: 'activity',
		}),
		async execute(raw, context) {
			const input = raw as Input
			let draft: SkillDraft
			try {
				draft = validateSkillDraft({
					name: input.name,
					description: input.description,
					body: input.body,
					...(input.origin ? { origin: input.origin } : {}),
				})
			} catch (error) {
				return refuse(`save_skill: ${error instanceof Error ? error.message : String(error)}`)
			}
			if (input.replaces !== undefined && input.replaces.trim() !== draft.name) {
				return refuse(
					`save_skill: replaces "${input.replaces}" must equal name "${draft.name}"; a skill is updated under its own name, not renamed.`,
				)
			}
			const sessionId = host.sessionId()
			let markdown: string
			try {
				markdown = composeSkillMarkdown(draft, {
					...(sessionId ? { sessionId } : {}),
					createdAt: (host.now ?? (() => new Date()))(),
				})
			} catch (error) {
				return refuse(`save_skill: ${error instanceof Error ? error.message : String(error)}`)
			}
			const cwd = host.cwd()
			const home = host.home?.()
			const config = host.config?.()
			const targets = planSkillTargets(draft.name, {
				cwd,
				...(home !== undefined ? { home } : {}),
				...(config ? { config } : {}),
			})
			const request: SaveSkillRequest = {
				draft,
				markdown,
				revealed: revealHiddenCharacters(markdown),
				targets,
				suggested: input.scope ?? 'user',
				...(sessionId ? { sessionId } : {}),
				warnings: skillWarnings(markdown),
			}
			let answer: SaveSkillAnswer
			try {
				answer = await host.confirm(request, context.abortSignal)
			} catch {
				answer = 'cancel'
			}
			if (context.abortSignal?.aborted) answer = 'cancel'
			if (answer !== 'user' && answer !== 'project') {
				return refuse(
					'The operator cancelled; nothing was written. Ask what to change, or leave it.',
				)
			}
			const target = targets[answer]
			try {
				writeFileAtomically(target.path, markdown)
			} catch (error) {
				return refuse(
					`save_skill: could not write ${target.path}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			host.saved?.({ name: draft.name, path: target.path })
			const notes = target.collisions.map((c) => describeCollision(c, cwd))
			return {
				success: true,
				output: [
					`Saved skill "${draft.name}" to ${target.displayPath}.${notes.length > 0 ? ` It ${notes.join('; ')}.` : ''}`,
					`It is offered to the model from the next turn; the operator can activate it now with /skills ${draft.name}.`,
				].join(' '),
				data: { name: draft.name, path: target.path, scope: answer },
			}
		},
	})
}
