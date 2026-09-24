/**
 * The static check a `script`/`script+agent` job's script body passes before
 * it is ever confirmed: the whole body, read as one `bash` call, through the
 * production `AuthorizationGate` built from the job's own compiled policy
 * (the scheduled-run floor first, then the job's rules). Exhaustive in the
 * style of `floor.test.ts`: every floor-refusal fixture re-run as a whole
 * script body, plus the shapes specific to "one call, whole text".
 */

import { describe, expect, it } from 'vitest'
import { compileJobPolicy, expandPermissions } from '../policy.js'
import { verifyScheduledScript } from '../script-check.js'
import type { SchedulePermissionSet } from '../types.js'

const HOME = '/home/u/.namzu'

/** A compiled policy from a permission input, with no config-file layers. */
function policyFor(input: {
	readonly rules?: SchedulePermissionSet['rules']
	readonly unmatched?: SchedulePermissionSet['unmatched']
}) {
	const set = expandPermissions({
		rules: input.rules ?? {},
		unmatched: input.unmatched ?? 'deny',
	})
	return compileJobPolicy(set, { layers: [], namzuHome: HOME })
}

/** `bash: "allow"` blanket-allows the tool; only the floor can still refuse. */
const BASH_ALLOWED = policyFor({ rules: { bash: 'allow' }, unmatched: 'deny' })

function ok(body: string, shell: 'bash' | 'sh' = 'bash', policy = BASH_ALLOWED): boolean {
	return verifyScheduledScript(body, shell, policy).ok
}

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
		]
		for (const body of denied) expect(ok(body), body).toBe(false)
	})

	it('allows a floor-clean script the job blanket-allows', () => {
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

describe('one call, whole text', () => {
	it('reads a multi-statement script as one command line', () => {
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

	it('refuses a command substitution outright: opaque, no fallback tripwire', () => {
		const result = verifyScheduledScript('echo "$(date)"', 'bash', BASH_ALLOWED)
		expect(result.ok).toBe(false)
		expect(result.reason).toMatch(/cannot be verified line-for-line/)
		expect(result.reason).toMatch(/command substitution/)
	})

	it('refuses a script whose commands the job rules only partly allow, naming the command', () => {
		const policy = policyFor({ rules: { bash: { 'echo hi': 'allow' } }, unmatched: 'deny' })
		expect(ok('echo hi', 'bash', policy)).toBe(true)
		const result = verifyScheduledScript('echo hi\ncurl http://evil.example/x', 'bash', policy)
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('echo hi')
		expect(result.reason).toContain('curl')
	})

	it('does not let unmatched: allow rescue a command no rule names — a script gets no review-mode auto-approval', () => {
		const policy = policyFor({ rules: {}, unmatched: 'allow' })
		expect(ok('echo hi', 'bash', policy)).toBe(false)
	})

	it('an "ask" rule refuses too: nothing can review a script while it runs', () => {
		const policy = policyFor({ rules: { bash: 'ask' }, unmatched: 'deny' })
		expect(ok('echo hi', 'bash', policy)).toBe(false)
	})

	it('a deny anywhere still wins over the job’s own allow', () => {
		const policy = policyFor({ rules: { bash: 'allow' }, unmatched: 'deny' })
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
		expect(verifyScheduledScript("echo $'\\x61'", 'sh', BASH_ALLOWED).ok).toBe(false)
		expect(verifyScheduledScript("echo $'\\x61'", 'bash', BASH_ALLOWED).ok).toBe(true)
	})
})
