/**
 * The static check every `script`/`script+agent` job's script body — and,
 * for `script+agent`, its wake-gate script — passes before it is ever
 * confirmed to run unattended.
 *
 * A pure `script` job has no model in the loop, ever: nothing reviews a call
 * it makes the way a live agent's tool calls are reviewed one at a time. The
 * design here gives the script body the review a live call's `allow`/`ask`
 * rules and `unmatched` can never usefully give it (there is no person and
 * no per-turn review mode to resolve an undecided call FOR a script), and
 * instead treats the operator's own confirmation of the exact text — bound
 * to it by the job's security digest — as the allowance:
 *
 * - the scheduled-run floor (and, on the whole script, the kernel's
 *   dangerous-command patterns) still refuse anything they always would;
 * - every config file's `deny` rules, and the job's OWN rules narrowed to
 *   their `deny` entries, are checked against EACH lexed command of the
 *   script in turn, so a refusal names the exact command and the rule that
 *   denied it (`compileScriptCheckPolicy`, `policy.ts`);
 * - `allow`/`ask` rules and `unmatched` are never consulted for the script.
 *   Revision (design.md §6, 2026-09-24, after review): the first version of
 *   this design evaluated the WHOLE script against the job's FULL permission
 *   set, so a script needed an `allow` rule (in practice a blanket `bash:
 *   allow`, since a script rarely matches one exact pattern) to pass at
 *   all — and because a `script+agent` job has only one permission set, that
 *   same blanket rule then gave the model UNRESTRICTED bash in the agent
 *   phase too. Dropping `allow`/`ask`/`unmatched` from the script's own
 *   check removes the reason to ever write one for this purpose; the job's
 *   `rules`/`unmatched` (allow included) still govern the agent phase
 *   exactly as before, unchanged.
 *
 * Failing closed: a script the lexer cannot fully account for (a command
 * substitution, a construct it does not model, a syntax error) is refused
 * outright, naming the lexer's own reason. There is no textual-tripwire
 * fallback here the way there is for an opaque ARGUMENT inside an otherwise
 * read line — a whole script that cannot be verified does not get to run
 * unattended, full stop.
 */

import { AuthorizationGate, NOOP_LOGGER, lexShellCommandLine } from '@namzu/sdk'
import { sanitizeLine } from '../integrations/notifications/desktop/sanitize.js'
import type { ScriptCheckPolicy } from './policy.js'

export interface ScriptCheckResult {
	readonly ok: boolean
	/** Why the script was refused. Absent when `ok`. */
	readonly reason?: string
}

const MAX_SHOWN = 240

/**
 * Text as a refusal quotes it: sanitized (this can be the job's own
 * confirmed script text, but a fresh re-verification at `__fire` runs this
 * over CURRENT config files, and `fire.ts`'s `blocked-config` reason reaches
 * `schedule show`/`history` and a desktop notification), one line, cut to
 * fit, in backticks.
 */
function shown(text: string, max = MAX_SHOWN): string {
	const cut = sanitizeLine(text, max)
	return cut.includes('`') ? `\`\` ${cut} \`\`` : `\`${cut}\``
}

/** A one-rule-set-only gate: only ever answers `deny` or the default "nothing matched". */
function denyOnlyGate(
	rules: ScriptCheckPolicy['floorRules'] | ScriptCheckPolicy['denyRules'],
	denyDangerousPatterns: boolean,
): AuthorizationGate {
	return new AuthorizationGate(
		{
			enabled: true,
			allowReadOnlyTools: false,
			denyDangerousPatterns,
			logDecisions: false,
			rules: [...rules],
		},
		NOOP_LOGGER,
	)
}

/**
 * Verify one script body against the policy a script gets
 * (`compileScriptCheckPolicy`): the lexer can fully account for it, the
 * whole text clears the scheduled-run floor and the kernel's dangerous-
 * command patterns, and no single lexed command in it is denied by a
 * config file or by the job's own `deny` rules.
 */
export function verifyScheduledScript(
	body: string,
	shell: 'bash' | 'sh',
	policy: ScriptCheckPolicy,
): ScriptCheckResult {
	const reading = lexShellCommandLine(body, { dialect: shell })
	if (reading.opaque) {
		return {
			ok: false,
			reason: `the script cannot be verified line-for-line (${reading.reasons[0] ?? 'a construct the lexer does not model'}); a script that cannot be read is refused rather than run unattended`,
		}
	}
	// A command whose own name is decided at runtime (`$(echo rm) -rf x`,
	// `$(echo git) push …`) is not opaque — the lexer read it fine — but no
	// deny rule can be trusted to have matched it: a pattern written against
	// the command's real name never sees a name that does not appear as
	// such anywhere in the script's text. A script confirmed once and never
	// reviewed live cannot lean on the operator noticing at run time the
	// way a live call's own review can; this is the same posture as
	// opaque, and for the same reason — refused rather than guessed at.
	for (const command of reading.commands) {
		const head = command.words[command.assignments]
		if (head?.expands) {
			return {
				ok: false,
				reason: `the command ${shown(command.text)}'s name is decided at runtime, so no rule can verify what it runs; a script whose commands cannot be verified is refused rather than run unattended`,
			}
		}
	}
	// The floor (and the kernel's own dangerous-command patterns) read the
	// WHOLE script at once, exactly as they would a live call's command
	// line: both track state across commands (a `cd` earlier in the script,
	// a pipeline's two sides for `curl … | sh`), which per-command text
	// alone would lose.
	const floorGate = denyOnlyGate(policy.floorRules, true)
	const floorResult = floorGate.evaluate({
		toolName: 'bash',
		toolInput: { command: body },
		toolDef: undefined,
		commandDialect: shell,
	})
	if (floorResult.decision === 'deny') {
		return { ok: false, reason: floorResult.reason }
	}
	// The job's own `deny` rules (and every config file's) are the
	// operator's own glob patterns, written with one command in mind
	// ("npm publish*": "deny"); checked per lexed command so a refusal
	// names the exact command that matched, not "somewhere in the script".
	if (policy.denyRules.length > 0) {
		const denyGate = denyOnlyGate(policy.denyRules, false)
		for (const command of reading.commands) {
			if (!command.text.trim()) continue
			const result = denyGate.evaluate({
				toolName: 'bash',
				toolInput: { command: command.text },
				toolDef: undefined,
				commandDialect: shell,
			})
			if (result.decision === 'deny') {
				return {
					ok: false,
					reason: `the command ${shown(command.text)} is denied: ${result.reason}`,
				}
			}
		}
	}
	return { ok: true }
}
