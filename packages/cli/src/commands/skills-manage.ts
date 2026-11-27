/**
 * `namzu skills add | create | remove`: the command line over the skill writer
 * in `skills/`. Parsing, the terminal, the folder-trust gate and the exit codes
 * live here; every rule about a skill lives in `skills/`.
 *
 * `--json` prints one object on standard output and nothing else there; a
 * question for the person goes to standard error.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import type { SkillsConfig } from '../config/schema.js'
import {
	EXIT_DATAERR,
	EXIT_FAIL,
	EXIT_NEEDS_CONSENT,
	EXIT_NOINPUT,
	EXIT_OK,
	EXIT_UNTRUSTED,
	EXIT_USAGE,
} from '../exit-codes.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { type TrustDecision, decideHeadlessTrust } from '../permissions/headless-trust.js'
import {
	type InstallContext,
	SKILL_ADD_MAX_INPUTS,
	type SkillOutcome,
	addSkillInput,
} from '../skills/add.js'
import { createSkill } from '../skills/create.js'
import type { InstallFsOps } from '../skills/install.js'
import { type RemoveOutcome, removeSkill } from '../skills/remove.js'
import type { SkillSaveScope } from '../skills/save.js'
import { terminalDisplayText } from '../tui/terminal-display.js'

export const SKILLS_MANAGE_VERBS = ['add', 'create', 'remove'] as const
export type SkillsManageVerb = (typeof SKILLS_MANAGE_VERBS)[number]

export const SKILLS_MANAGE_HELP = [
	'Usage:',
	'  namzu skills add <file.zip|file.skill|file.md|folder>... [--scope user|project] [--name <skill>] [--replace] [--yes] [--json]',
	'  namzu skills create <name> --description <text> (--instructions <text> | --instructions-file <path|->) [--scope user|project] [--replace] [--json]',
	'  namzu skills remove <name> [--scope user|project] [--yes] [--json]',
	'',
	'add     Put skills you were given into your skills folder (~/.namzu/skills) or, with',
	'        --scope project, the project’s (./.namzu/skills, trusted folders only). Up to 20',
	'        inputs of at most 30 MB each. A skill that can run commands is shown to you first.',
	'create  Write a skill from flags, with no model: the name, a description and instructions.',
	'remove  Take a skill out of your skills or the project’s. A copy is moved to',
	'        ~/.namzu/backups/skills/, not deleted.',
	'',
	'Options:',
	'  --scope user|project   Where the skill lives (default user)',
	'  --name <skill>         add: use this name instead of the one in the file (one input only)',
	'  --replace              Replace a skill of the same name (the old folder is kept in backups)',
	'  --yes                  Accept what is shown: the commands a skill can run, a replacement, a removal',
	'  --description <text>   create: when to use the skill, at most 1024 characters, no <tags>',
	'  --instructions <text>  create: the skill’s instructions',
	'  --instructions-file <path|->  create: read the instructions from a file, or standard input',
	'  --cwd <dir>            The folder whose project skills are meant (default: here)',
	'  --json                 Print one JSON object on standard output',
	'',
	'Exit status: 0 done, 1 something failed, 64 the command line is wrong, 65 refused as unsafe,',
	'66 not found, 75 a yes is needed and nobody can be asked (use --yes), 77 the folder is not trusted.',
].join('\n')

export interface SkillsManageDeps {
	readonly out: (text: string) => void
	readonly err: (text: string) => void
	/** A person is at the terminal and can be asked. */
	readonly isTTY: boolean
	readonly ask: (question: string) => Promise<string>
	readonly readStdin: () => Promise<string>
	readonly cwd: () => string
	/** The OS home folder (tests); absent means `NAMZU_HOME` and the real home. */
	readonly home?: string
	readonly config?: SkillsConfig
	readonly now?: () => Date
	readonly ops?: InstallFsOps
	/** The folder-trust decision (tests). */
	readonly trust?: (cwd: string) => TrustDecision
}

interface Parsed {
	readonly positional: string[]
	readonly flags: Map<string, string | true>
	readonly error?: string
}

const VALUE_FLAGS = new Set([
	'--scope',
	'--name',
	'--cwd',
	'--description',
	'--instructions',
	'--instructions-file',
])
const BOOL_FLAGS = new Set(['--replace', '--yes', '--json'])
const ALLOWED: Record<SkillsManageVerb, ReadonlySet<string>> = {
	add: new Set(['--scope', '--name', '--cwd', '--replace', '--yes', '--json']),
	create: new Set([
		'--scope',
		'--cwd',
		'--description',
		'--instructions',
		'--instructions-file',
		'--replace',
		'--json',
	]),
	remove: new Set(['--scope', '--cwd', '--yes', '--json']),
}

function parse(verb: SkillsManageVerb, raw: readonly string[]): Parsed {
	const positional: string[] = []
	const flags = new Map<string, string | true>()
	let rest = false
	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i] as string
		if (rest || !arg.startsWith('--')) {
			positional.push(arg)
			continue
		}
		if (arg === '--') {
			rest = true
			continue
		}
		const eq = arg.indexOf('=')
		const name = eq > 0 ? arg.slice(0, eq) : arg
		if (!ALLOWED[verb].has(name)) {
			return { positional, flags, error: `Unknown option for skills ${verb}: ${name}` }
		}
		if (VALUE_FLAGS.has(name)) {
			const value = eq > 0 ? arg.slice(eq + 1) : raw[++i]
			// Text may begin with dashes (instructions that open with `---`); a path, name or scope may not.
			const text = name === '--description' || name === '--instructions'
			if (value === undefined || (!text && eq < 0 && value.startsWith('--') && value !== '-')) {
				return { positional, flags, error: `${name} needs a value.` }
			}
			flags.set(name, value)
		} else if (BOOL_FLAGS.has(name) && eq < 0) {
			flags.set(name, true)
		} else {
			return { positional, flags, error: `${name} does not take a value.` }
		}
	}
	return { positional, flags }
}

const oneLine = (text: string): string => terminalDisplayText(text).replace(/[\t\n\r]+/g, ' ')

interface Setup {
	readonly scope: SkillSaveScope
	readonly cwd: string
	readonly flags: Map<string, string | true>
	readonly json: boolean
}

export async function runSkillsManage(
	verb: SkillsManageVerb,
	rawArgs: readonly string[],
	deps: SkillsManageDeps,
): Promise<number> {
	if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
		deps.out(SKILLS_MANAGE_HELP)
		return EXIT_OK
	}
	const parsed = parse(verb, rawArgs)
	const json = parsed.flags.has('--json')
	const usage = (message: string): number => {
		if (json) deps.out(JSON.stringify({ version: 1, ok: false, error: message }))
		else deps.err(message)
		return EXIT_USAGE
	}
	if (parsed.error !== undefined) return usage(parsed.error)
	const scopeFlag = parsed.flags.get('--scope')
	if (scopeFlag !== undefined && scopeFlag !== 'user' && scopeFlag !== 'project') {
		return usage('--scope must be user or project.')
	}
	const scope: SkillSaveScope = scopeFlag === 'project' ? 'project' : 'user'
	const cwdFlag = parsed.flags.get('--cwd')
	const cwd = typeof cwdFlag === 'string' ? resolve(deps.cwd(), cwdFlag) : deps.cwd()
	if (typeof cwdFlag === 'string') {
		try {
			if (!statSync(cwd).isDirectory()) return usage(`--cwd is not a directory: ${cwd}`)
		} catch {
			return usage(`--cwd does not exist: ${cwd}`)
		}
	}

	if (verb === 'add') {
		if (parsed.positional.length === 0)
			return usage('Name at least one skill file or folder to add.')
		if (parsed.positional.length > SKILL_ADD_MAX_INPUTS) {
			return usage(`You can add up to ${SKILL_ADD_MAX_INPUTS} skills at a time.`)
		}
		if (parsed.flags.has('--name') && parsed.positional.length > 1) {
			return usage('--name names one skill, so it goes with one input.')
		}
	} else if (verb === 'create') {
		if (parsed.positional.length !== 1)
			return usage('Give the skill a name: namzu skills create <name> …')
		if (typeof parsed.flags.get('--description') !== 'string')
			return usage('--description is required.')
		const hasText = parsed.flags.has('--instructions')
		const hasFile = parsed.flags.has('--instructions-file')
		if (hasText === hasFile)
			return usage(
				'Give the instructions with --instructions or --instructions-file, not both and not neither.',
			)
	} else if (parsed.positional.length !== 1) {
		return usage('Name the skill to remove: namzu skills remove <name>')
	}

	// Project skills are project files: only in a folder somebody trusted. A user skill never reads the project's.
	let effectiveCwd = cwd
	const trust = (
		deps.trust ?? ((dir: string) => decideHeadlessTrust({ cwd: dir, trustFlag: false }))
	)(cwd)
	if (trust.allowed) effectiveCwd = trust.cwd
	else if (scope === 'project') {
		const message = `Project skills can be changed only in a folder you trust: ${cwd}. Run namzu there once and accept the trust prompt, or use --scope user.`
		if (json) deps.out(JSON.stringify({ version: 1, ok: false, error: message }))
		else deps.err(message)
		return EXIT_UNTRUSTED
	} else {
		// An untrusted folder's own skills are not read: collisions are planned against the user's folders only.
		effectiveCwd = namzuHomePath(deps.home)
	}

	const ask = deps.isTTY
		? async (question: string, preview: readonly string[]): Promise<boolean> => {
				for (const line of preview) deps.err(`  ${oneLine(line)}`)
				return /^y(es)?$/i.test((await deps.ask(`${oneLine(question)} [y/N] `)).trim())
			}
		: undefined
	const base: Omit<InstallContext, 'scope' | 'yes' | 'replace'> = {
		cwd: effectiveCwd,
		displayCwd: cwd,
		...(deps.home !== undefined ? { home: deps.home } : {}),
		...(deps.config ? { config: deps.config } : {}),
		...(ask ? { ask } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.ops ? { ops: deps.ops } : {}),
	}
	const setup: Setup = { scope, cwd: effectiveCwd, flags: parsed.flags, json }

	if (verb === 'remove') {
		const outcome = await removeSkill(parsed.positional[0] as string, {
			...(scopeFlag !== undefined ? { scope } : {}),
			cwd: effectiveCwd,
			displayCwd: cwd,
			...(deps.home !== undefined ? { home: deps.home } : {}),
			...(deps.config ? { config: deps.config } : {}),
			yes: parsed.flags.has('--yes'),
			...(ask ? { ask } : {}),
			...(deps.now ? { now: deps.now } : {}),
			...(deps.ops ? { ops: deps.ops } : {}),
		})
		return reportRemove(outcome, setup, deps)
	}

	const ctx: InstallContext = {
		...base,
		scope,
		yes: parsed.flags.has('--yes'),
		replace: parsed.flags.has('--replace'),
	}
	if (verb === 'create') {
		let instructions: string
		const file = parsed.flags.get('--instructions-file')
		if (typeof file === 'string') {
			try {
				instructions =
					file === '-' ? await deps.readStdin() : readInstructionsFile(resolve(deps.cwd(), file))
			} catch (error) {
				const message = `Could not read the instructions: ${error instanceof Error ? error.message : String(error)}`
				if (json) deps.out(JSON.stringify({ version: 1, ok: false, error: message }))
				else deps.err(message)
				return EXIT_NOINPUT
			}
		} else instructions = parsed.flags.get('--instructions') as string
		const outcome = await createSkill(
			{
				name: parsed.positional[0] as string,
				description: parsed.flags.get('--description') as string,
				instructions,
			},
			ctx,
		)
		return reportInstall([outcome], setup, deps, false)
	}

	const name = parsed.flags.get('--name')
	const outcomes: SkillOutcome[] = []
	for (const input of parsed.positional) {
		outcomes.push(
			await addSkillInput(
				resolve(deps.cwd(), input),
				typeof name === 'string' ? { name } : {},
				ctx,
			),
		)
	}
	// Name the inputs as the person typed them.
	const typed = outcomes.map((o, i) => ({ ...o, input: parsed.positional[i] as string }))
	return reportInstall(typed, setup, deps, true)
}

function readInstructionsFile(path: string): string {
	const stat = statSync(path)
	if (!stat.isFile()) throw new Error(`${path} is not a file.`)
	if (stat.size > 1024 * 1024) throw new Error(`${path} is larger than 1 MB.`)
	return readFileSync(path, 'utf8')
}

const DONE = new Set(['added', 'replaced'])

function installExit(outcomes: readonly SkillOutcome[]): number {
	const count = (...statuses: string[]): number =>
		outcomes.filter((o) => statuses.includes(o.status)).length
	const failures = count('failed', 'declined')
	const refusals = count('refused')
	if (failures === 0 && refusals === 0)
		return count('needs-consent') > 0 ? EXIT_NEEDS_CONSENT : EXIT_OK
	if (failures === 0 && refusals === outcomes.length) return EXIT_DATAERR
	return EXIT_FAIL
}

function reportInstall(
	outcomes: readonly SkillOutcome[],
	setup: Setup,
	deps: SkillsManageDeps,
	many: boolean,
): number {
	const code = installExit(outcomes)
	if (setup.json) {
		deps.out(
			JSON.stringify({
				version: 1,
				ok: code === EXIT_OK,
				exitCode: code,
				added: outcomes.filter((o) => DONE.has(o.status)).length,
				results: outcomes,
			}),
		)
		return code
	}
	for (const o of outcomes) {
		const label = many && outcomes.length > 1 ? `${oneLine(o.input)}: ` : ''
		const line = `${label}${oneLine(o.message)}`
		if (DONE.has(o.status)) deps.out(line)
		else deps.err(line)
		for (const finding of o.findings)
			(DONE.has(o.status) ? deps.out : deps.err)(`  ${oneLine(finding)}`)
		for (const note of o.notes) (DONE.has(o.status) ? deps.out : deps.err)(`  It ${oneLine(note)}.`)
		if (o.status === 'needs-consent') for (const p of o.preview ?? []) deps.err(`  ${oneLine(p)}`)
	}
	return code
}

function reportRemove(outcome: RemoveOutcome, setup: Setup, deps: SkillsManageDeps): number {
	const code =
		outcome.status === 'removed'
			? EXIT_OK
			: outcome.status === 'not-found'
				? EXIT_NOINPUT
				: outcome.status === 'usage'
					? EXIT_USAGE
					: outcome.status === 'unsafe'
						? EXIT_DATAERR
						: outcome.status === 'needs-consent'
							? EXIT_NEEDS_CONSENT
							: EXIT_FAIL
	if (setup.json) {
		deps.out(JSON.stringify({ version: 1, ok: code === EXIT_OK, exitCode: code, ...outcome }))
		return code
	}
	const write = outcome.status === 'removed' ? deps.out : deps.err
	write(oneLine(outcome.message))
	if (outcome.status === 'needs-consent')
		for (const d of outcome.details) deps.err(`  ${oneLine(d)}`)
	return code
}
