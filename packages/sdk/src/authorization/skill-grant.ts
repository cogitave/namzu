/**
 * A skill's `allowed-tools`, as what it is everywhere else: a pre-approval.
 *
 * The field comes from the Agent Skills format, and the runtime that made it
 * popular documents it plainly: the listed tools may be used without asking
 * for the rest of the turn that loaded the skill, and "it does not restrict
 * which tools are available: every tool remains callable, and your permission
 * settings still govern tools that are not listed."
 *
 * This kernel read it the other way round, as a RESTRICTION. A skill written
 * for that ecosystem says `allowed-tools: Read Grep` to mean "these two are
 * fine without a prompt", and a turn that loaded it here lost `bash` on its
 * next batch and was told to "restrict yourself to" two tools — so the model
 * stopped doing the work and tried to do everything through whatever the
 * skill described. The field was never meant to take anything away.
 *
 * What it grants, and what it does not:
 *
 * - **Grants**: a call that matches an entry skips the approval PROMPT for the
 *   rest of the turn, on the same footing as a person answering "allow" for
 *   the turn. The turn ends, the grant ends; loading the skill again in a
 *   later turn grants again.
 * - **Never overrides**: an operator `deny` rule, an operator `ask` rule, plan
 *   mode, `strict` mode, a call that reaches outside the working directory or
 *   the sandbox, or a call the tool itself declares destructive. Those are all
 *   statements by the operator or the tool; a skill is repository content and
 *   cannot outrank either.
 * - **Never adds a tool**: an entry names a tool this turn already has, or it
 *   is ignored and the model is told so. An unknown name widens nothing.
 *
 * Granting is equivalent to the operator trusting that skill's commands,
 * which is why only a skill the host chose to load can grant anything; see
 * `docs/` for the CLI's folder-trust story.
 */

import { MAX_CUSTOM_PATTERN_LENGTH } from '../constants/authorization/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { evaluateRule } from './rules.js'

/**
 * Split an `allowed-tools` value into entries.
 *
 * Accepts every spelling the format uses: space-separated (`Read Grep Bash`),
 * comma-separated (`Read, Grep`), and — once the frontmatter reader has turned
 * a YAML list into one line — the items of a list. Separators inside
 * parentheses belong to the entry, so `Bash(git add *)` stays one entry.
 *
 * `undefined` means the skill declared nothing. An empty array means it
 * declared the field empty. Neither grants anything, and neither restricts
 * anything, so the distinction survives only for a host that wants to show
 * what the author wrote.
 */
export function parseAllowedTools(declared: string | undefined): readonly string[] | undefined {
	if (declared === undefined) return undefined
	const entries: string[] = []
	let current = ''
	let depth = 0
	const flush = () => {
		const entry = current.trim()
		if (entry.length > 0) entries.push(entry)
		current = ''
	}
	for (const char of declared) {
		if (char === '(') depth += 1
		if (char === ')' && depth > 0) depth -= 1
		if (depth === 0 && (char === ',' || /\s/.test(char))) {
			flush()
			continue
		}
		current += char
	}
	flush()
	return entries
}

/**
 * The tool names the Agent Skills ecosystem writes, and what they are here.
 *
 * Keyed lower-case: names are matched without regard to case, because a skill
 * author writes `Read` and this kernel's tool is `read`, and a grant lost to
 * capitalisation is a prompt nobody can explain.
 */
export const SKILL_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	read: 'read',
	write: 'write',
	edit: 'edit',
	multiedit: 'edit',
	bash: 'bash',
	grep: 'grep',
	glob: 'glob',
	ls: 'ls',
	webfetch: 'web_fetch',
	websearch: 'web_search',
	skill: 'skill',
	askuserquestion: 'ask_user_question',
	task: 'create_task',
	agent: 'create_task',
	lsp: 'lsp',
})

/**
 * How a grant compiler learns what a name means in this turn: the registered
 * tool a name refers to, or `undefined` for one this turn does not have.
 * `commandArgument` is what lets a `Bash(<pattern>)` entry be matched against
 * the command line rather than the serialised input.
 */
export type SkillGrantToolResolver = (
	name: string,
) => { readonly name: string; readonly commandArgument?: string } | undefined

/** One compiled entry: a whole tool, or one tool's command line matching a pattern. */
export interface SkillGrantEntry {
	/** The registered tool name. */
	readonly tool: string
	/** Present for a pattern entry: the argument holding the command line. */
	readonly argument?: string
	/** Present for a pattern entry: an anchored regular-expression source. */
	readonly pattern?: string
	/** The entry as the author wrote it, for messages. */
	readonly declared: string
}

export interface CompiledSkillGrant {
	readonly entries: readonly SkillGrantEntry[]
	/** Entries that granted nothing, with the reason, for the model and the log. */
	readonly ignored: readonly {
		readonly entry: string
		readonly reason: string
	}[]
}

/** The two placeholders a pattern may use for the skill's own directory. */
const SKILL_DIR_PLACEHOLDERS = ['${CLAUDE_SKILL_DIR}', '${NAMZU_SKILL_DIR}'] as const

const ENTRY_SHAPE = /^([A-Za-z0-9_.\-]+)(?:\(([\s\S]*)\))?$/

/**
 * Turn a permission glob into an anchored regular-expression source.
 *
 * The one glob dialect for command permissions, shared with the CLI's
 * `[permissions]` table so that `Bash(git status *)` in a skill and
 * `bash = { "git status *" = "allow" }` in config mean the same commands:
 *
 * - `*` matches any run of characters, `?` exactly one, everything else is
 *   literal;
 * - backslashes become forward slashes, so one pattern works on every platform;
 * - a pattern ending in `<space>*` also matches the bare command, so
 *   `git status *` covers `git status` as well as `git status -s`, and does
 *   not cover `git statusx`.
 */
export function permissionPatternToRegExpSource(pattern: string): string {
	const normalized = pattern.replaceAll('\\', '/')
	const escaped = normalized
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	const trailingSpaceStar = escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}( .*)?` : escaped
	return `^${trailingSpaceStar}$`
}

/**
 * Compile a skill's parsed `allowed-tools` into grant entries.
 *
 * Pure: the resolver supplies everything the turn knows. An entry that cannot
 * be honoured exactly is ignored and reported, never approximated — the only
 * safe approximation of a permission is a narrower one, and "ignored" is the
 * narrowest.
 */
export function compileSkillGrant(
	declared: readonly string[],
	options: {
		readonly resolveTool: SkillGrantToolResolver
		/** The skill's directory, for `${CLAUDE_SKILL_DIR}` / `${NAMZU_SKILL_DIR}`. */
		readonly skillDirectory?: string
	},
): CompiledSkillGrant {
	const entries: SkillGrantEntry[] = []
	const ignored: { entry: string; reason: string }[] = []

	for (const entry of declared) {
		const shape = ENTRY_SHAPE.exec(entry)
		if (!shape) {
			ignored.push({ entry, reason: 'not a tool name or `Tool(pattern)`' })
			continue
		}
		const written = shape[1] ?? ''
		const specifier = shape[2]?.trim()
		const alias = SKILL_TOOL_NAME_ALIASES[written.toLowerCase()]
		const tool = options.resolveTool(alias ?? written)
		if (!tool) {
			ignored.push({ entry, reason: 'this turn has no tool by that name' })
			continue
		}

		if (specifier === undefined || specifier === '' || specifier.replaceAll('*', '') === '') {
			entries.push({ tool: tool.name, declared: entry })
			continue
		}

		if (tool.commandArgument === undefined) {
			ignored.push({
				entry,
				reason: `a pattern is honoured only for a tool that takes a command line, and \`${tool.name}\` does not; nothing was granted for it`,
			})
			continue
		}

		let pattern = specifier
		// The legacy prefix spelling `npm run test:*` means `npm run test *`.
		if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
		if (SKILL_DIR_PLACEHOLDERS.some((placeholder) => pattern.includes(placeholder))) {
			if (!options.skillDirectory) {
				ignored.push({
					entry,
					reason: "the skill's directory is not known in this turn",
				})
				continue
			}
			for (const placeholder of SKILL_DIR_PLACEHOLDERS) {
				pattern = pattern.replaceAll(placeholder, options.skillDirectory)
			}
		}
		const source = permissionPatternToRegExpSource(pattern)
		if (source.length > MAX_CUSTOM_PATTERN_LENGTH) {
			ignored.push({ entry, reason: 'the pattern is too long to evaluate' })
			continue
		}
		entries.push({
			tool: tool.name,
			argument: tool.commandArgument,
			pattern: source,
			declared: entry,
		})
	}

	return { entries, ignored }
}

interface HeldGrant {
	readonly skill: string
	readonly entry: SkillGrantEntry
	readonly compiled?: RegExp
	readonly names: Set<string>
}

/**
 * The skill grants in force for one turn.
 *
 * Turn-scoped for the reason `ToolGrantSet` is: a grant is a statement about
 * this turn's work. It is created with the turn and dropped with it, so it
 * never reaches the next message, and a delegated child — which runs its own
 * turn — starts with an empty one of its own rather than its parent's.
 */
export class SkillGrantSet {
	private readonly held: HeldGrant[] = []

	/** Record a skill's compiled entries. Loading the same skill twice is harmless. */
	grant(skill: string, compiled: CompiledSkillGrant): void {
		for (const entry of compiled.entries) {
			const duplicate = this.held.some(
				(held) =>
					held.skill === skill &&
					held.entry.tool === entry.tool &&
					held.entry.argument === entry.argument &&
					held.entry.pattern === entry.pattern,
			)
			if (duplicate) continue
			this.held.push({
				skill,
				entry,
				...(entry.pattern !== undefined ? { compiled: new RegExp(entry.pattern) } : {}),
				names: new Set([entry.tool]),
			})
		}
	}

	/**
	 * The skill whose grant covers this call, or `undefined`.
	 *
	 * A pattern entry is matched the way an operator's `allow` pattern is: per
	 * command, every command in the line must match, and a line the reader
	 * cannot see through (a substitution, a heredoc) matches nothing. So
	 * `Bash(git status *)` covers `git status -s` and not
	 * `git status && git push`.
	 */
	coveringSkill(
		call: { readonly name: string; readonly input: unknown },
		toolDef?: ToolDefinition,
	): string | undefined {
		for (const held of this.held) {
			if (held.entry.tool !== call.name) continue
			if (held.entry.pattern === undefined || held.entry.argument === undefined) return held.skill
			const decision = evaluateRule(
				{
					type: 'argument_pattern',
					toolNames: [held.entry.tool],
					argument: held.entry.argument,
					pattern: held.entry.pattern,
					decision: 'allow',
				},
				call.name,
				call.input,
				toolDef,
				held.compiled,
				held.names,
			)
			if (decision === 'allow') return held.skill
		}
		return undefined
	}

	get size(): number {
		return this.held.length
	}

	/** What is granted, by skill, as the authors wrote it. */
	list(): { readonly skill: string; readonly entry: string }[] {
		return this.held.map((held) => ({
			skill: held.skill,
			entry: held.entry.declared,
		}))
	}
}
