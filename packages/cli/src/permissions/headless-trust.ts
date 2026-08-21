/**
 * The folder-trust gate for the headless one-shots.
 *
 * `integrations/trust/store.ts` states the contract in its own header: "before
 * namzu reads, runs commands in, or edits files in a directory, the user must
 * trust it." That was true of the TUI and false of everything else —
 * `isTrusted` had exactly one caller, `tui/App.tsx`. `run` and `run-stream`
 * opened a session in whatever directory they were pointed at, with tools
 * auto-approved because there is nobody to ask, so
 *
 *     git clone <a stranger's repository> && cd <it> && namzu run "what is this?"
 *
 * ran that repository's code on the machine, unattended, having asked nobody.
 *
 * ## What this stops, and what it does not
 *
 * It stops one thing: a headless run in a directory no human has vouched for
 * does not start. A decision currently made by nobody becomes a decision made
 * by someone, on the record.
 *
 * It does NOT stop a trusted directory that later turns hostile — a `git pull`
 * into a trusted checkout can bring in anything, and trust is a statement about
 * a location rather than about its current contents. It does not stop anything
 * INSIDE a trusted directory, where the operator's rules and the safety gate
 * are the only controls. And it does not stop an operator who passes the
 * opt-in reflexively. This raises the floor from "nobody was asked" to
 * "somebody typed it". It is not a sandbox and must not be described as one.
 *
 * ## Why not gate only the reading of `AGENTS.md`
 *
 * That was proposed on the grounds that a system-prompt read is authority
 * where a tool result is only data, which is true and still the wrong fix.
 * Anyone who can write `AGENTS.md` in that repository can write the build
 * script, the test file, the install hook — all of which run with tools
 * auto-approved. Declining to read the attacker's markdown while executing the
 * attacker's code blocks the weaker vector, reports success on a run that is
 * already compromised, and would make the instructions feature silently dead
 * in CI where nothing has ever been trusted.
 *
 * ## Refuse, never degrade
 *
 * There is no reduced mode. "Degrade gracefully" here would mean executing
 * slightly less of the stranger's code and printing something that looks like
 * an answer, which is the failure this package keeps finding rather than a
 * milder version of it.
 */

import { isTrusted } from '../integrations/trust/store.js'
import { canonicalProjectPath } from './canonical-project.js'

export type TrustDecision =
	| {
			readonly allowed: true
			/** Canonical target captured by the decision; use it for every later operation. */
			readonly cwd: string
	  }
	| {
			readonly allowed: false
			/** Names the folder and both ways forward. */
			readonly message: string
	  }

export interface TrustCheck {
	readonly cwd: string
	/** `--trust` was passed: the operator accepts this folder for this run. */
	readonly trustFlag: boolean
	/** Injectable for tests. Defaults to the persistent `~/.namzu/trust.json`. */
	readonly trusted?: (dir: string) => boolean
}

export function decideHeadlessTrust(check: TrustCheck): TrustDecision {
	// Capture the real target exactly once. The permission and every operation
	// it admits must refer to the same directory entry even if the lexical
	// `--cwd` was a symlink and somebody repoints it immediately afterward.
	let cwd: string
	try {
		cwd = canonicalProjectPath(check.cwd)
	} catch {
		return {
			allowed: false,
			message: `refusing to run because the working directory changed or became unavailable while trust was being checked: ${check.cwd}`,
		}
	}
	// `--trust` is per-run and is deliberately NOT written to the trust file.
	// One reflexive use must not change the machine's state forever; the TUI
	// stays the only path that records durable trust, because that is the one
	// where a human is actually looking at a prompt.
	if (check.trustFlag) return { allowed: true, cwd }
	const isDirTrusted = check.trusted ?? ((dir: string) => isTrusted(dir))
	if (isDirTrusted(cwd)) return { allowed: true, cwd }
	return {
		allowed: false,
		message: [
			`refusing to run in a folder nobody has trusted: ${cwd}`,
			'',
			"namzu reads this folder's files, runs commands in it and executes its",
			'code, and a headless run approves those tools without asking because',
			'there is nobody to ask.',
			'',
			'Run `namzu` here once and accept the trust prompt to trust the folder',
			'permanently, or pass --trust to accept it for this run only.',
		].join('\n'),
	}
}
