/**
 * The input surface shared by the two headless one-shots, `run` and
 * `run-stream`.
 *
 * They are the same command with different OUTPUT — `run` prints the reply for
 * a shell, `run-stream` emits one JSON event per line for a host UI — so they
 * have no business accepting different INPUT. They did: `run-stream` learned to
 * parse `--cwd`, `--model`, `--provider`, `--session` and `--skills`, while
 * `run` parsed nothing at all and joined every argument into the prompt. So
 * `namzu run --cwd /elsewhere "fix the test"` sent the model a prompt beginning
 * `--cwd /elsewhere` and ran in this directory, which is the defect that was
 * already fixed once, in the sibling command.
 *
 * One parser, so the two cannot drift again.
 *
 * What they still differ on is how a bad argument is REPORTED, and that is
 * deliberate: `run` answers a shell, so it exits non-zero; `run-stream` answers
 * a line-scanning host, so it emits an error event and exits 0. Each is the
 * only signal its caller is listening for.
 */

import { statSync } from 'node:fs'
import { resolve } from 'node:path'

export interface RunFlags {
	session: string | null
	model: string | null
	provider: string | null
	instance: string | null
	/** Where the agent works: filesystem tools, sub-agents, session store, skills. */
	cwd: string | null
	skills: string[]
	/**
	 * `--flags` this parser does not know.
	 *
	 * Collected rather than folded into `rest`, because `rest` becomes the
	 * PROMPT. Anything unrecognised is refused instead of being quietly said
	 * out loud to a model — a typo'd flag is a mistake, and reading it aloud is
	 * the worst available response to one.
	 */
	unknown: string[]
	rest: string[]
}

export function parseRunFlags(rawArgs: readonly string[]): RunFlags {
	const out: RunFlags = {
		session: null,
		model: null,
		provider: null,
		instance: null,
		cwd: null,
		skills: [],
		unknown: [],
		rest: [],
	}
	const take = (a: string, name: string, set: (v: string) => void, i: { v: number }): boolean => {
		if (a === `--${name}` && i.v + 1 < rawArgs.length) {
			set(rawArgs[++i.v])
			return true
		}
		if (a.startsWith(`--${name}=`)) {
			set(a.slice(name.length + 3))
			return true
		}
		return false
	}
	const trimmed = (assign: (v: string | null) => void) => (v: string) => assign(v.trim() || null)
	for (const idx = { v: 0 }; idx.v < rawArgs.length; idx.v++) {
		const a = rawArgs[idx.v]
		// End of options. Everything after it is prompt, verbatim — the escape
		// for a prompt that legitimately begins with a dash, which is the only
		// case the refusal below would otherwise take away.
		if (a === '--') {
			out.rest.push(...rawArgs.slice(idx.v + 1))
			break
		}
		if (
			take(
				a,
				'cwd',
				trimmed((v) => {
					out.cwd = v
				}),
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'session',
				trimmed((v) => {
					out.session = v
				}),
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'model',
				trimmed((v) => {
					out.model = v
				}),
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'provider',
				trimmed((v) => {
					out.provider = v
				}),
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'instance',
				trimmed((v) => {
					out.instance = v
				}),
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'skills',
				(v) => {
					out.skills = v
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				},
				idx,
			)
		)
			continue
		// Accepted and ignored: the headless commands never prompt for tool
		// approval, so there is nothing for a bypass flag to bypass. Refusing it
		// would break `namzu --yolo run …`, which reads as reasonable and is
		// already how the interactive launch is spelled.
		if (a === '--yolo' || a === '--dangerously-skip-permissions') continue
		if (a.startsWith('--')) {
			out.unknown.push(a.split('=')[0])
			continue
		}
		out.rest.push(a)
	}
	return out
}

/**
 * Absolute path for a `--cwd`, or an error naming what is wrong with it.
 *
 * Relative values resolve against the process's own directory, which is the
 * only base a caller can predict. A path that is missing or is not a directory
 * is refused rather than silently falling back: falling back is how a typo'd
 * `--cwd` becomes a run that searched somewhere else and reported finding
 * nothing, which reads as "the file isn't there".
 */
export function resolveWorkingDirectory(raw: string | null): { cwd: string } | { error: string } {
	if (!raw) return { cwd: process.cwd() }
	const cwd = resolve(process.cwd(), raw)
	try {
		if (!statSync(cwd).isDirectory()) return { error: `--cwd is not a directory: ${cwd}` }
	} catch {
		return { error: `--cwd does not exist: ${cwd}` }
	}
	return { cwd }
}

/**
 * The `--skills a,b,c` system block for a turn, or undefined when none were
 * asked for or none of them exist.
 *
 * Lives beside the parser because resolving the names IS what the flag means,
 * and because the skills a turn can load are the ones under its `--cwd` — the
 * two flags have to be read together or a host is offered a skill in one
 * directory and denied it in another.
 *
 * Best-effort: a skill that cannot be read costs its guidance, not the turn.
 */
export async function loadSkillsContext(
	cwd: string,
	names: readonly string[],
): Promise<string | undefined> {
	if (names.length === 0) return undefined
	try {
		const { discoverSkills, loadSkillBody, composeSkillsPrompt } = await import(
			'../skills/store.js'
		)
		const wanted = new Set(names)
		const active = discoverSkills({ cwd })
			.filter((s) => wanted.has(s.name))
			.map((s) => ({ name: s.name, body: loadSkillBody(s) }))
		return composeSkillsPrompt(active) ?? undefined
	} catch {
		return undefined
	}
}

/** The `--flags` refusal message both commands use, so they word it the same. */
export function unknownOptionMessage(unknown: readonly string[]): string {
	return `unknown option(s): ${unknown.join(', ')} — pass \`--\` before a prompt that starts with a dash`
}
