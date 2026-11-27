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
 * ## Skills are commands too
 *
 * Every skill a person can invoke is also `/<name>`: its body is the template,
 * so a skill and a command file are one mechanism with one `$ARGUMENTS` rule.
 * A skill the author marked model-only (`invocation: model`) or hid from the
 * person (`user-invocable: false`) gets no command. A command file of the same
 * name shadows the skill; `/skills <name>` still activates a skill for the
 * whole conversation.
 *
 * ## Arguments
 *
 * `$ARGUMENTS` in the template is replaced by whatever followed the command.
 * A template WITHOUT it, invoked WITH arguments, is refused rather than run —
 * see `expandCommand`. Dropping them silently is the failure this file is
 * written to avoid, and appending them somewhere the author did not ask for
 * would be guessing where they belong.
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
	InlineShellError,
	expandPluginRootText,
	findInlineShell,
	parseFrontmatter,
	substituteEscaped,
} from '@namzu/sdk'
import type { SkillsConfig } from '../config/schema.js'
import { CHECK_HINT } from '../integrations/plugins/check-hint.js'
import { namzuHomePath } from '../integrations/state/home.js'
import type { SkillShellOrigin } from '../skills/skill-shell.js'
import { type SkillInfo, discoverSkills, loadSkillFile } from '../skills/store.js'

export type UserCommandSource = 'user' | 'project' | 'skill' | 'plugin'

export interface UserCommand {
	/** Invoked as `/<name>`. The filename without `.md`. */
	readonly name: string
	readonly description: string
	/** The prompt template. Empty when the file could not be read. */
	readonly template: string
	readonly path: string
	readonly source: UserCommandSource
	/** What the composer shows after `/<name> ` (`argument-hint`). */
	readonly argumentHint?: string
	/** A command of a plugin read through the common plugin layout: `/<plugin>:<command>` also names it. */
	readonly commonLayout?: true
	/** For a command that is a skill: the `hooks` block it carries, attached when the person runs it. */
	readonly hooksSource?: string
	/**
	 * Whose text this is, for the shell commands it may hold: a command file's own source, and a
	 * skill's tier (`system`, `user` or `project`). Absent for a command built by hand.
	 */
	readonly shellOrigin?: SkillShellOrigin
	/** For a command that is a skill: its `allowed-tools`, as written. */
	readonly allowedTools?: string
	/** For a command that is a skill: its folder. */
	readonly directory?: string
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

/**
 * The hint as the composer shows it. A YAML list (`[file]`) reaches here as
 * its items without the brackets, so a hint that is not already bracketed or
 * angled gets square brackets back.
 */
export function displayHint(hint: string): string {
	return /^[[<(]/.test(hint) ? hint : `[${hint}]`
}

/** The token a template uses to receive what followed the command. */
export const ARGUMENTS_TOKEN = '$ARGUMENTS'

export function userCommandsDir(home?: string): string {
	return join(namzuHomePath(home), 'commands')
}

export function projectCommandsDir(cwd: string = process.cwd()): string {
	return join(cwd, '.namzu', 'commands')
}

/**
 * One command file's text to a command: usable, or carrying the `problem`
 * that makes it unusable. The one place the command-file rules live; the
 * plugin validator calls it on the text it read, so it cannot disagree with
 * what a session does with the same file.
 *
 * Same fence-decides rule as the skill reader: a file with no `---` is all
 * body, which is the common case for a command, and a file that opens one
 * must parse. The absence test mirrors the kernel reader's own so the two
 * cannot disagree about what counts as having frontmatter.
 */
export function parseCommandText(
	raw: string,
	path: string,
	name: string,
	source: UserCommandSource,
): UserCommand {
	try {
		if (!raw.trimStart().startsWith('---')) {
			return {
				name,
				description: '(no description)',
				template: raw.trim(),
				path,
				source,
				...shellOriginOf(source),
			}
		}
		const { values, body } = parseFrontmatter(raw, path, { lists: ['argument-hint'] })
		const description =
			values.description?.kind === 'scalar' ? values.description.value : '(no description)'
		const hint =
			values['argument-hint']?.kind === 'scalar' ? values['argument-hint'].value.trim() : ''
		return {
			name,
			description,
			template: body,
			path,
			source,
			...(hint ? { argumentHint: displayHint(hint) } : {}),
			...shellOriginOf(source),
		}
	} catch (err) {
		return {
			name,
			description: '(could not be read)',
			template: '',
			path,
			source,
			problem: err instanceof Error ? err.message : String(err),
		}
	}
}

function shellOriginOf(source: UserCommandSource): { shellOrigin?: SkillShellOrigin } {
	return source === 'skill' ? {} : { shellOrigin: source }
}

/** The frontmatter keys a command file reads. Any other is ignored. */
export const COMMAND_FILE_KEYS: readonly string[] = ['description', 'argument-hint']

function readCommandsFrom(
	dir: string,
	source: UserCommandSource,
	/** A plugin's name: the command is then `/<plugin>__<file>`. */
	plugin?: string,
	/** One file of `dir` (its name without `.md`) when a plugin named a file, not a folder. */
	only?: string,
	/** The plugin's folder, put in for `${NAMZU_PLUGIN_ROOT}` in the command's text. */
	pluginRoot?: string,
	/** The plugin was read through the common plugin layout. */
	commonLayout?: boolean,
): UserCommand[] {
	let files: string[]
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith('.md'))
			.map((e) => e.name)
			.filter((file) => only === undefined || file === `${only}.md`)
	} catch {
		// No directory is not an error: most projects define no commands.
		return []
	}

	const out: UserCommand[] = []
	for (const file of files) {
		const path = join(dir, file)
		const name = `${plugin !== undefined ? `${plugin}__` : ''}${file.slice(0, -'.md'.length)}`
		let raw: string
		try {
			raw = readFileSync(path, 'utf8')
		} catch {
			continue
		}

		const parsed = parseCommandText(raw, path, name, source)
		const expanded =
			pluginRoot !== undefined && parsed.template !== ''
				? {
						...parsed,
						template: expandPluginRootText(parsed.template, pluginRoot),
					}
				: parsed
		const command: UserCommand =
			commonLayout === true ? { ...expanded, commonLayout: true } : expanded
		// A plugin's command that cannot be used says where its author can see why.
		out.push(
			plugin !== undefined && command.problem
				? { ...command, problem: `${command.problem} ${CHECK_HINT}` }
				: command,
		)
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
	opts: {
		home?: string
		cwd?: string
		reserved?: readonly string[]
		/** The skills section of the config, so a disabled skill is listed as unavailable. */
		skills?: SkillsConfig
		/**
		 * Which skills become commands. `all` is every invocable skill;
		 * `declared` leaves out the ones that ship with Namzu, for a headless
		 * prompt where only what the operator wrote can claim a name; `none`
		 * (the default) leaves skills out, so a caller that wants only command
		 * files gets exactly those.
		 */
		skillCommands?: 'all' | 'declared' | 'none'
		/**
		 * Folders of command files that enabled plugins contribute. Each file is
		 * named `<plugin>__<file>`, so a plugin cannot take another command's
		 * name; the user's and project's own files still shadow a plugin's.
		 */
		pluginCommandDirs?: readonly {
			readonly plugin: string
			readonly dir: string
			readonly only?: string
			readonly root?: string
			readonly commonLayout?: boolean
		}[]
	} = {},
): UserCommand[] {
	const reserved = new Set(opts.reserved ?? [])
	const userDir = userCommandsDir(opts.home)
	const projectDir = projectCommandsDir(opts.cwd)
	const user = readCommandsFrom(userDir, 'user')
	// `$HOME/.namzu/commands` does not become project-authored merely because a
	// session starts in `$HOME`. Besides mislabelling the picker, the old second
	// read let the project-precedence pass overwrite the same command as
	// `source: project`. Resolve symlinks too so spelling cannot change scope.
	const project = samePhysicalDirectory(userDir, projectDir)
		? []
		: readCommandsFrom(projectDir, 'project')

	const byName = new Map<string, UserCommand>()
	for (const c of skillCommands(opts)) byName.set(c.name, c) // a command file shadows a skill
	for (const source of opts.pluginCommandDirs ?? []) {
		for (const c of readCommandsFrom(
			source.dir,
			'plugin',
			source.plugin,
			source.only,
			source.root,
			source.commonLayout,
		))
			byName.set(c.name, c)
	}
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

/**
 * The command a typed name means. An exact name wins; otherwise
 * `<plugin>:<command>` finds `<plugin>__<command>` when that command came from
 * a plugin read through the common plugin layout, so the plugin's own
 * documentation works as written.
 */
export function findUserCommand(
	commands: readonly UserCommand[],
	name: string,
): UserCommand | undefined {
	const exact = commands.find((command) => command.name === name)
	if (exact !== undefined) return exact
	const at = name.indexOf(':')
	if (at <= 0 || at === name.length - 1) return undefined
	const spelled = `${name.slice(0, at)}__${name.slice(at + 1)}`
	return commands.find((command) => command.name === spelled && command.commonLayout === true)
}

/** Where the template's first line says the skill's folder goes; never a name a skill author writes. */
const BASE_DIRECTORY_TOKEN = '${NAMZU_BASE_DIRECTORY}'

/** A skill as a command: its body is the template, its folder is named so relative files resolve. */
function skillAsCommand(skill: SkillInfo): UserCommand {
	const base = {
		name: skill.name,
		description: skill.description,
		path: skill.path,
		source: 'skill' as const,
		...(skill.argumentHint ? { argumentHint: displayHint(skill.argumentHint) } : {}),
		...(skill.hooksSource !== undefined ? { hooksSource: skill.hooksSource } : {}),
		shellOrigin: skill.source,
		directory: dirname(skill.path),
	}
	if (skill.problem) return { ...base, template: '', problem: skill.problem }
	try {
		const { body, allowedTools } = loadSkillFile(skill)
		return {
			...base,
			...(allowedTools ? { allowedTools } : {}),
			// The folder is written as its variable and put in with the arguments, escaped, when the
			// text is loaded: a folder named like a command must never be read as one.
			template: `Base directory for this skill: ${BASE_DIRECTORY_TOKEN}\n\n${body}`,
		}
	} catch (err) {
		return { ...base, template: '', problem: err instanceof Error ? err.message : String(err) }
	}
}

function skillCommands(opts: {
	home?: string
	cwd?: string
	skills?: SkillsConfig
	skillCommands?: 'all' | 'declared' | 'none'
}): UserCommand[] {
	const mode = opts.skillCommands ?? 'none'
	if (mode === 'none') return []
	return discoverSkills({
		...(opts.home !== undefined ? { home: opts.home } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.skills !== undefined ? { config: opts.skills } : {}),
	})
		.filter(
			(skill) =>
				skill.invocation !== 'model' &&
				skill.userInvocable !== false &&
				(mode === 'all' || skill.tier !== 'system'),
		)
		.map(skillAsCommand)
}

function samePhysicalDirectory(left: string, right: string): boolean {
	const canonical = (path: string): string => {
		let value: string
		try {
			value = realpathSync(path)
		} catch {
			value = resolve(path)
		}
		return platform() === 'win32' ? value.toLocaleLowerCase('en-US') : value
	}
	return canonical(left) === canonical(right)
}

export type HeadlessExpansion =
	/** Not a command. Send it as written. */
	| { readonly kind: 'unchanged'; readonly prompt: string }
	| {
			readonly kind: 'expanded'
			readonly prompt: string
			readonly name: string
			/** Set when the text still holds shell commands, which the caller runs before sending it. */
			readonly shell?: ShellExpansion
	  }
	/**
	 * `fixable` says whether the caller can get what it asked for by sending
	 * something else.
	 *
	 * `true` — an interactive builtin named headlessly, or arguments given to a
	 * template that takes none. Change the prompt and it works.
	 *
	 * `false` — the command FILE is the problem, and no prompt fixes a file. The
	 * two used to be one `refused`, which is fine for a person reading the
	 * reason and not for a host process deciding whether to try again.
	 */
	| { readonly kind: 'refused'; readonly reason: string; readonly fixable: boolean }

/**
 * Resolve a headless prompt that may name one of the operator's own commands.
 *
 * `namzu exec "/ozet hedef.js"` used to send that string to the model verbatim.
 * The model, reasonably, tried to make sense of it — offering to create a file
 * called `ozet hedef.js`. The turn exited 0 with confident output that had
 * nothing to do with the command. It did not fail; it quietly did something
 * else, which is the shape worth removing.
 *
 * ## Why a leading `/` is not enough to call it a command
 *
 * `namzu exec "/usr/local/bin is missing"` and `namzu exec "/clear the cache in
 * redis"` are ordinary prompts. Treating every leading slash as a command would
 * break them, and breaking a working prompt to fix a broken one is not a trade
 * worth making. So the test is not the slash — it is whether the first token
 * names a command **this project actually declares**.
 *
 * That asymmetry is the whole rule. A file in `.namzu/commands/` is an explicit
 * declaration by the operator, so matching it is high-confidence. A built-in's
 * name is a common English word that nobody declared, so matching it is not.
 *
 * The one exception is a prompt that is EXACTLY a built-in and nothing else:
 * `namzu exec "/help"` is not a sentence anybody means literally, and answering
 * it with a model improvising on the string is the same silent misfire. With
 * arguments — `/clear the cache` — it stays prose, because there the words
 * carry a meaning the command name does not.
 */
export function expandHeadlessCommand(
	prompt: string,
	opts: {
		home?: string
		cwd?: string
		builtins?: readonly string[]
		skills?: SkillsConfig
	} = {},
): HeadlessExpansion {
	const trimmed = prompt.trim()
	if (!trimmed.startsWith('/')) return { kind: 'unchanged', prompt }

	const [token, ...rest] = trimmed.slice(1).split(/\s+/)
	const name = token ?? ''
	if (!name) return { kind: 'unchanged', prompt }

	const builtins = new Set(opts.builtins ?? [])
	if (rest.length === 0 && builtins.has(name)) {
		return {
			kind: 'refused',
			reason: `/${name} is an interactive command and does nothing in \`namzu exec\`. Run \`namzu\` for the terminal agent, or pass a prompt instead.`,
			fixable: true,
		}
	}

	const commands = discoverUserCommands({
		...(opts.home !== undefined ? { home: opts.home } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.skills !== undefined ? { skills: opts.skills } : {}),
		// A skill that ships with Namzu is not something this project declared.
		skillCommands: 'declared',
		reserved: [...builtins],
	})
	const found = findUserCommand(commands, name)
	if (!found) return { kind: 'unchanged', prompt }

	const expanded = expandCommand(found, rest.join(' '))
	return expanded.ok
		? {
				kind: 'expanded',
				prompt: expanded.prompt,
				name,
				...(expanded.shell ? { shell: expanded.shell } : {}),
			}
		: // A command whose FILE is the problem is not fixable by sending a
			// different prompt. Taken from `found.problem` rather than from the
			// refusal reason, because that is where the fact lives — reading it back
			// out of the sentence would make the sentence unrewordable.
			{ kind: 'refused', reason: expanded.reason, fixable: found.problem === undefined }
}

/**
 * What the loader needs to run the shell commands a template holds: set on an
 * expansion whose text holds any. The commands have NOT run; `prompt` still has
 * them in it, with the arguments already put in and escaped.
 */
export interface ShellExpansion {
	readonly name: string
	readonly origin: SkillShellOrigin
	readonly allowedTools?: string
	readonly directory?: string
}

export type ExpandResult =
	| { readonly ok: true; readonly prompt: string; readonly shell?: ShellExpansion }
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
	// A template that holds shell commands has its values escaped, so that what a person
	// types after the name can never start a command, and then read for them once. A
	// template without any is filled in exactly as it always was.
	if (findInlineShell(command.template).length > 0) {
		const shell: ShellExpansion = {
			name: command.name,
			origin: command.shellOrigin ?? 'project',
			...(command.allowedTools ? { allowedTools: command.allowedTools } : {}),
			...(command.directory ? { directory: command.directory } : {}),
		}
		if (trimmed.length > 0 && !command.template.includes(ARGUMENTS_TOKEN)) {
			return noExtraText(command, trimmed)
		}
		try {
			const prompt = substituteEscaped(command.template, {
				[ARGUMENTS_TOKEN]: trimmed,
				...(command.directory
					? {
							[BASE_DIRECTORY_TOKEN]: command.directory,
							'${NAMZU_SKILL_DIR}': command.directory,
							'${CLAUDE_SKILL_DIR}': command.directory,
						}
					: {}),
			})
			return { ok: true, prompt, shell }
		} catch (error) {
			if (error instanceof InlineShellError) return { ok: false, reason: error.message }
			throw error
		}
	}
	// No command in the text, so a value cannot start one: put the folder in as written.
	const template =
		command.directory !== undefined
			? command.template.split(BASE_DIRECTORY_TOKEN).join(command.directory)
			: command.template
	if (template.includes(ARGUMENTS_TOKEN)) {
		return { ok: true, prompt: template.split(ARGUMENTS_TOKEN).join(trimmed) }
	}
	if (trimmed.length === 0) return { ok: true, prompt: template }
	return noExtraText(command, trimmed)
}

function noExtraText(command: UserCommand, trimmed: string): ExpandResult {
	// Which file, not where it lives: a skill's file is always named SKILL.md,
	// so it is told by its folder.
	const file = basename(command.path)
	const fileName = file === 'SKILL.md' ? `${basename(dirname(command.path))}/${file}` : file
	return {
		ok: false,
		reason: [
			`/${command.name} does not take extra text, so “${trimmed}” was not used.`,
			`Run /${command.name} on its own, or edit ${fileName} to say where extra text goes.`,
		].join('\n'),
	}
}
