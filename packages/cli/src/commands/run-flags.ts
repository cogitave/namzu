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

import { DEFAULT_GATE_MAX_RETRIES, createCommandGate } from '@namzu/sdk'
import type { ReviewAnswer } from '@namzu/sdk'

import type { Preferences, ProviderChoice, ProviderId } from '../integrations/providers/index.js'

export interface RunFlags {
	session: string | null
	model: string | null
	provider: string | null
	/** Where the agent works: filesystem tools, sub-agents, session store, skills. */
	cwd: string | null
	/** How calls no `[permissions]` rule decided are resolved: prompt/auto/strict. */
	permissionMode: string | null
	/** --yolo / --dangerously-skip-permissions was given. */
	skipPermissions: boolean
	/**
	 * `--trust`: the operator accepts this working directory, for this run.
	 *
	 * Separate from `skipPermissions` on purpose, and the two must never imply
	 * each other. Skipping permissions is a statement about which tool calls may
	 * run inside a folder; trust is a statement about the folder. Someone who
	 * passes `--yolo` in their own repository has asserted nothing whatever
	 * about a stranger's, and letting an existing flag satisfy a new gate is the
	 * definition of a gate satisfied by accident.
	 */
	trust: boolean
	/** --continue: pick up the most recent conversation here. */
	continueLast: boolean
	/** --resume <id>: pick up this conversation and no other. */
	resume: string | null
	skills: string[]
	/**
	 * `--gate '<command>'`, repeatable — commands that must pass before the
	 * run is allowed to settle.
	 *
	 * An ARRAY rather than a single value, and repeat-to-append rather than
	 * last-wins, because "typecheck AND test" is the ordinary case and a
	 * last-wins flag would silently drop the first one. Order is preserved:
	 * they run in the order given and stop at the first failure.
	 */
	gates: string[]
	/**
	 * `--gate-retries <n>`: how many times a failing gate may hand the answer
	 * back before the run stops with `answer_rejected`.
	 */
	gateRetries: number | null
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
		cwd: null,
		permissionMode: null,
		skipPermissions: false,
		trust: false,
		continueLast: false,
		resume: null,
		skills: [],
		gates: [],
		gateRetries: null,
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
				'permission-mode',
				trimmed((v) => {
					out.permissionMode = v
				}),
				idx,
			)
		)
			continue
		if (a === '--continue' || a === '-c') {
			out.continueLast = true
			continue
		}
		if (a === '--trust') {
			out.trust = true
			continue
		}
		if (
			take(
				a,
				'resume',
				trimmed((v) => {
					out.resume = v
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
		// Appends rather than replaces. `--gate a --gate b` means both, in that
		// order; a last-wins reading would run only `b` and report success on a
		// project whose types do not compile.
		if (
			take(
				a,
				'gate',
				(v) => {
					const cmd = v.trim()
					if (cmd) out.gates.push(cmd)
				},
				idx,
			)
		)
			continue
		if (
			take(
				a,
				'gate-retries',
				(v) => {
					out.gateRetries = Number(v)
				},
				idx,
			)
		)
			continue
		// Was accepted and ignored, because a headless run never prompted and so
		// had nothing to bypass. Now that an operator can write rules, it means
		// something: `auto` for the calls no rule decided. It still cannot reopen
		// a `deny` or the dangerous-pattern floor, so it promises more than it
		// delivers — deliberately, since a flag with this name should read as
		// more dangerous than it is rather than less.
		if (a === '--yolo' || a === '--dangerously-skip-permissions') {
			out.skipPermissions = true
			continue
		}
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

/**
 * The `reviewAnswer` a `--gate` set implies, or `undefined` for no gates.
 *
 * Lives beside the parser for the reason at the top of this file: both
 * headless commands take the same input, so both must build the same gate
 * from it. A flag parsed by the shared parser and honoured by only one
 * command is worse than a flag neither has — the operator gets a run that
 * accepted `--gate` and settled on a red build, with nothing to read that
 * says why.
 *
 * Returns the reviewer AND the rejection budget together, because the two
 * have to agree: the gate stops executing after `maxRetries` and the run
 * stops after `maxAnswerReviews`, and a run whose budget outlasts its gate
 * spends its remaining turns being told the same thing.
 */
export function buildGate(
	flags: Pick<RunFlags, 'gates' | 'gateRetries'>,
	cwd: string,
): { reviewAnswer: ReviewAnswer; maxAnswerReviews: number } | undefined {
	if (flags.gates.length === 0) return undefined
	const retries =
		flags.gateRetries !== null && Number.isInteger(flags.gateRetries) && flags.gateRetries > 0
			? flags.gateRetries
			: DEFAULT_GATE_MAX_RETRIES
	return {
		reviewAnswer: createCommandGate({ commands: flags.gates, cwd, maxRetries: retries }),
		maxAnswerReviews: retries,
	}
}

/**
 * Options that belong to the program rather than to a command, so they are
 * only accepted BEFORE the command name.
 *
 * Listed here so the refusal below can tell the two mistakes apart. Keep in
 * step with the `.option(...)` calls on the program in `cli.ts`.
 */
const GLOBAL_ONLY_OPTIONS: ReadonlySet<string> = new Set([
	'-v',
	'--verbose',
	'-q',
	'--quiet',
	'--log-format',
	'-f',
	'--format',
])

/** The `--flags` refusal message both commands use, so they word it the same. */
export function unknownOptionMessage(unknown: readonly string[]): string {
	// Two different mistakes reached the same sentence, and only one of them
	// was ever about a dash.
	//
	// `namzu run "..." --verbose` is the order a person types, and the generic
	// message answered it with "pass `--` before a prompt that starts with a
	// dash" — advice for a prompt beginning with `-`, which this is not. The
	// reader is then looking at the wrong half of their command line. The flag
	// is real, it works, and it is simply positional.
	//
	// Same rule as the permission gate and the trust prompt: a refusal that
	// does not say what to do instead produces a retry of the same thing.
	const misplaced = unknown.filter((option) =>
		GLOBAL_ONLY_OPTIONS.has(option.split('=')[0] ?? option),
	)
	if (misplaced.length > 0) {
		const example = misplaced[0]
		return (
			`${misplaced.join(', ')} ${misplaced.length === 1 ? 'is a global option' : 'are global options'}, ` +
			`accepted before the command rather than after it — try \`namzu ${example} <command> …\``
		)
	}
	return `unknown option(s): ${unknown.join(', ')} — pass \`--\` before a prompt that starts with a dash`
}

/**
 * Apply `--provider` / `--model` to the configured provider chain.
 *
 * Here rather than in each command for the reason at the top of this file: both
 * commands take the same input, and the two `--provider` readings below differ
 * in a way that only shows up once failover exists. Written twice, they drift
 * once.
 *
 * **`--provider X` replaces the chain with X alone**, rather than moving X to
 * the head and keeping the rest as fallbacks. An operator who names one provider
 * on a command line and gets an answer from a different one has been switched
 * silently — and they would have no way to see it, because the flag they passed
 * says otherwise. Today the two readings behave identically, since nothing falls
 * over; the decision is recorded now so it is not settled later by whichever is
 * easier to write.
 *
 * **`--model` alone re-models the existing primary** and leaves the chain
 * intact: it is a statement about the model, not about which providers are
 * viable. Passed together with `--provider`, it models the single member that
 * replaced the chain.
 */
export function applyProviderFlags(
	prefs: Preferences,
	flags: Pick<RunFlags, 'provider' | 'model'>,
): Preferences {
	if (!flags.provider && !flags.model) return prefs

	if (flags.provider) {
		const member: ProviderChoice = {
			id: flags.provider as ProviderId,
			...(flags.model ? { model: flags.model } : {}),
		}
		return { ...prefs, providers: [member] }
	}

	const [head, ...rest] = prefs.providers
	if (!head) return prefs
	// `flags.model` is non-null here: the early return above covers the case
	// where neither flag was given, and the branch above covers `--provider`.
	const remodelled: ProviderChoice = { id: head.id, model: flags.model as string }
	return { ...prefs, providers: [remodelled, ...rest] }
}
