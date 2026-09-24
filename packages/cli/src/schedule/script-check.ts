/**
 * The static check every `script`/`script+agent` job's script body — and,
 * for `script+agent`, its wake-gate script — passes before it is ever
 * confirmed to run unattended.
 *
 * A pure `script` job has no model in the loop, ever: nothing reviews a call
 * it makes the way a live agent's tool calls are reviewed one at a time.
 * The design here is to give the WHOLE script body exactly the review one
 * of the model's own `bash` calls already gets — the same lexer, the same
 * scheduled-run floor, the same job-authored rules, the same production
 * `AuthorizationGate` — evaluated once, at confirm time (and re-verified,
 * cheaply, by `confirmationHolds()` at every `__fire`, since the job's
 * security digest now includes the script). What a live call is allowed to
 * do call-by-call, a script is allowed to do as one fixed, human-read,
 * human-confirmed body.
 *
 * Two consequences fall out of "one call, whole text":
 *
 * - `unmatched: allow`/`ask`-style review does not rescue an unmatched
 *   command the way it would for a live turn (where a person or an "auto"
 *   review mode decides what the gate left undecided): nothing here ever
 *   resolves a `review` decision, because there is no person and no
 *   per-turn review mode to resolve it FOR a script. Only a literal `allow`
 *   from the gate passes. An operator authorizes a script job the same way
 *   they authorize an agent's shell access in general — `bash: "allow"` (or
 *   a pattern that matches the exact script text) — and the floor plus any
 *   config file's denials remain the actual safety net.
 * - A script that mixes several statements is judged as ONE command line,
 *   because that is what it is: `cmd1 && cmd2; cmd3` is a single argument to
 *   the synthetic `bash` call, exactly as the lexer already reads a live
 *   call's multi-statement command line.
 *
 * Failing closed: a script the lexer cannot fully account for (a command
 * substitution, a construct it does not model, a syntax error) is refused
 * outright, naming the lexer's own reason. There is no textual-tripwire
 * fallback here the way there is for an opaque ARGUMENT inside an otherwise
 * read line — a whole script that cannot be verified does not get to run
 * unattended, full stop.
 */

import { AuthorizationGate, NOOP_LOGGER, lexShellCommandLine } from '@namzu/sdk'
import type { CompiledJobPolicy } from './policy.js'

export interface ScriptCheckResult {
	readonly ok: boolean
	/** Why the script was refused. Absent when `ok`. */
	readonly reason?: string
}

const MAX_SHOWN = 240

/** Text as a refusal quotes it: one line, cut to fit, in backticks. */
function shown(text: string, max = MAX_SHOWN): string {
	const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
	const cut = [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
	return cut.includes('`') ? `\`\` ${cut} \`\`` : `\`${cut}\``
}

/**
 * Verify one script body against a job's compiled policy: the lexer can
 * fully account for it, and the whole body, read as one `bash` call, is
 * `allow` under the scheduled-run floor and the job's own rules (in that
 * order — `compileJobPolicy` already puts the floor first).
 *
 * `policy` is the job's OWN compiled policy (`compileJobPolicy(job.
 * permissions, {...})`), not a separate, narrower shape: per the settled
 * design decision, a script goes through the same permissions an agent
 * phase would, evaluated once instead of call-by-call.
 */
export function verifyScheduledScript(
	body: string,
	shell: 'bash' | 'sh',
	policy: Pick<CompiledJobPolicy, 'rules'>,
): ScriptCheckResult {
	const reading = lexShellCommandLine(body, { dialect: shell })
	if (reading.opaque) {
		return {
			ok: false,
			reason: `the script cannot be verified line-for-line (${reading.reasons[0] ?? 'a construct the lexer does not model'}); a script that cannot be read is refused rather than run unattended`,
		}
	}
	const gate = new AuthorizationGate(
		{
			enabled: true,
			allowReadOnlyTools: false,
			denyDangerousPatterns: true,
			logDecisions: false,
			rules: [...policy.rules],
		},
		NOOP_LOGGER,
	)
	const result = gate.evaluate({
		toolName: 'bash',
		toolInput: { command: body },
		toolDef: undefined,
		commandDialect: shell,
	})
	if (result.decision !== 'allow') {
		return {
			ok: false,
			reason: `the job's permissions do not allow this script, read as one command (${shown(body)}): ${result.reason}`,
		}
	}
	return { ok: true }
}
