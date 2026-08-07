/**
 * User-defined slash commands — one `.md` file per command.
 *
 * A command is a markdown file whose body is a prompt template:
 *
 *   ~/.namzu/commands/<name>.md    available everywhere
 *   <cwd>/.namzu/commands/<name>.md   this project only
 *
 * The name is the filename without `.md`, so `review.md` is `/review`. A
 * project command shadows a user command of the same name, which is the same
 * precedence skills use.
 *
 * ## Why this is not `discoverSkills`
 *
 * The kernel's `discoverSkills` finds DIRECTORIES containing a `SKILL.md`, and
 * returns `[]` for a folder of loose `.md` files — silently, because an empty
 * roster is a legitimate answer to "no skills here". A command is one file, so
 * that loader cannot serve this layout and would report nothing rather than
 * fail. What IS reused is the part worth sharing: `parseFrontmatter`, so there
 * is exactly one definition of what a `---` block means anywhere in the repo.
 *
 * ## Arguments
 *
 * `$ARGUMENTS` in the template is replaced by whatever followed the command.
 * A template WITHOUT it, invoked WITH arguments, is refused rather than run —
 * see `expandCommand`. Dropping them silently is the failure this file is
 * written to avoid, and appending them somewhere the author did not ask for
 * would be guessing where they belong.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '@namzu/sdk'

export type UserCommandSource = 'user' | 'project'

export interface UserCommand {
	/** Invoked as `/<name>`. The filename without `.md`. */
	readonly name: string
	readonly description: string
	/** The prompt template. Empty when the file could not be read. */
	readonly template: string
	readonly path: string
	readonly source: UserCommandSource
	/**
	 * Why this command cannot be used, when it cannot.
	 *
	 * Same contract as `SkillInfo.problem`: a file that will not parse is
	 * refused, but it stays listed with its reason so one bad file does not
	 * quietly remove the rest — and so a file the operator can see on disk is
	 * accounted for rather than missing.
	 */
	readonly problem?: string
}

/** The token a template uses to receive what followed the command. */
export const ARGUMENTS_TOKEN = '$ARGUMENTS'

export function userCommandsDir(home: string = homedir()): string {
	return join(home, '.namzu', 'commands')
}

export function projectCommandsDir(cwd: string = process.cwd()): string {
	return join(cwd, '.namzu', 'commands')
}

function readCommandsFrom(dir: string, source: UserCommandSource): UserCommand[] {
	let files: string[]
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith('.md'))
			.map((e) => e.name)
	} catch {
		// No directory is not an error: most projects define no commands.
		return []
	}

	const out: UserCommand[] = []
	for (const file of files) {
		const path = join(dir, file)
		const name = file.slice(0, -'.md'.length)
		let raw: string
		try {
			raw = readFileSync(path, 'utf8')
		} catch {
			continue
		}

		// Same fence-decides rule as the skill reader: a file with no `---` is
		// all body, which is the common case for a command, and a file that
		// opens one must parse. The absence test mirrors the kernel reader's own
		// so the two cannot disagree about what counts as having frontmatter.
		try {
			if (!raw.trimStart().startsWith('---')) {
				out.push({ name, description: '(no description)', template: raw.trim(), path, source })
				continue
			}
			const { values, body } = parseFrontmatter(raw, path)
			const description =
				values.description?.kind === 'scalar' ? values.description.value : '(no description)'
			out.push({ name, description, template: body, path, source })
		} catch (err) {
			out.push({
				name,
				description: '(could not be read)',
				template: '',
				path,
				source,
				problem: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return out
}

/**
 * Every user-defined command, project shadowing user on a name clash.
 *
 * `reserved` names are dropped with a `problem` rather than allowed to win:
 * a file called `help.md` must not replace `/help`, because a builtin someone
 * relies on disappearing when a file appears is the worst kind of surprise —
 * and silently ignoring the file would leave its author with no idea why it
 * never ran.
 */
export function discoverUserCommands(
	opts: { home?: string; cwd?: string; reserved?: readonly string[] } = {},
): UserCommand[] {
	const reserved = new Set(opts.reserved ?? [])
	const user = readCommandsFrom(userCommandsDir(opts.home), 'user')
	const project = readCommandsFrom(projectCommandsDir(opts.cwd), 'project')

	const byName = new Map<string, UserCommand>()
	for (const c of user) byName.set(c.name, c)
	for (const c of project) byName.set(c.name, c) // project wins

	return [...byName.values()]
		.map((c) =>
			reserved.has(c.name)
				? { ...c, problem: `"/${c.name}" is a built-in command, so this file is not used.` }
				: c,
		)
		.sort((a, b) => a.name.localeCompare(b.name))
}

export type ExpandResult =
	| { readonly ok: true; readonly prompt: string }
	| { readonly ok: false; readonly reason: string }

/**
 * Fill a command's template with the arguments it was invoked with.
 *
 * Three cases, and the third is the decision worth defending:
 *
 * 1. Template has `$ARGUMENTS` → substituted, with `''` when none were given.
 * 2. No `$ARGUMENTS`, no arguments → the template is a static prompt. Fine.
 * 3. No `$ARGUMENTS`, arguments given → **refused**, naming the file and the
 *    fix.
 *
 * The third could have appended them under a heading instead, and that is
 * friendlier in the moment. It was rejected because it guesses where the author
 * wanted them and because the author never finds out their template ignores
 * arguments. Refusing is one-time friction that teaches the contract.
 *
 * It is also the reversible direction: relaxing a refusal into an append later
 * breaks nobody, while tightening an append into a refusal breaks everyone who
 * had come to rely on it. Where a contract is hard to change, pick the one that
 * can still be changed.
 */
export function expandCommand(command: UserCommand, args: string): ExpandResult {
	if (command.problem) return { ok: false, reason: command.problem }

	const trimmed = args.trim()
	if (command.template.includes(ARGUMENTS_TOKEN)) {
		return { ok: true, prompt: command.template.split(ARGUMENTS_TOKEN).join(trimmed) }
	}
	if (trimmed.length === 0) return { ok: true, prompt: command.template }

	return {
		ok: false,
		reason: [
			`/${command.name} takes no arguments, but you gave: ${trimmed}`,
			'',
			`Add ${ARGUMENTS_TOKEN} where they belong in ${command.path}, and they will be`,
			'substituted there. Running it now would silently discard them.',
		].join('\n'),
	}
}
