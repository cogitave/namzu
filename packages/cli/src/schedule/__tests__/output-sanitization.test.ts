/**
 * Untrusted script/wake-gate output reaching a human surface — `schedule
 * show`/`history` (text), a desktop notification — is sanitized the same
 * way a model's own answer already is (`sanitizeLine`): control characters,
 * terminal escape sequences and invisible/bidi tricks are stripped before
 * they reach a terminal or a notification. `--json` stays raw, since it is
 * data for a program, not a screen.
 */

import { describe, expect, it } from 'vitest'
import { historyCommand } from '../commands/list.js'
import { noticeText, scriptSummaryOf } from '../daemon/notify.js'
import { parseWakeGateOutput } from '../fire/wake-gate.js'
import { compileScriptCheckPolicy, expandPermissions } from '../policy.js'
import { verifyScheduledScript } from '../script-check.js'
import { appendHistory } from '../store/history.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

// A BEL, an ANSI "clear screen and hide cursor" sequence, and a zero-width
// space: the shapes a real terminal would act on rather than display.
const HOSTILE = '\x07\x1b[2J\x1b[?25l\u200bhi'

describe('the wake-gate’s reason', () => {
	it('sanitizes the quoted stdout slice', () => {
		const result = parseWakeGateOutput(`${HOSTILE}\n`, 4_000)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.reason).not.toContain('\x07')
			expect(result.reason).not.toContain('\x1b')
			expect(result.reason).not.toContain('\u200b')
		}
	})
})

describe('the script-check’s reason', () => {
	it('sanitizes the quoted (denied) command text', () => {
		// The deny PATTERN is the operator's own config, out of scope here; the
		// hostile text is in the SCRIPT's command, which `shown()` quotes.
		const set = expandPermissions({ rules: { bash: { 'curl*': 'deny' } }, unmatched: 'deny' })
		const policy = compileScriptCheckPolicy(set, { layers: [], namzuHome: '/home/u/.namzu' })
		const result = verifyScheduledScript(`curl ${HOSTILE}`, 'bash', policy)
		expect(result.ok).toBe(false)
		expect(result.reason).not.toContain('\x07')
		expect(result.reason).not.toContain('\x1b')
		expect(result.reason).not.toContain('\u200b')
	})
})

describe('scriptSummaryOf', () => {
	it('sanitizes the extracted line', () => {
		const summary = scriptSummaryOf({ scriptOutput: { stdout: `${HOSTILE}\n` } })
		expect(summary).not.toContain('\x07')
		expect(summary).not.toContain('\x1b')
		expect(summary).not.toContain('\u200b')
		expect(summary).toContain('hi')
	})
})

describe('noticeText: check-failed', () => {
	it('sanitizes the reason', () => {
		const { body } = noticeText(
			'check-failed',
			{
				name: 'j',
				notify: { finished: true, failed: true, awaitingApproval: true, includeSummary: true },
			},
			{ at: new Date(), reason: HOSTILE },
		)
		expect(body).not.toContain('\x07')
		expect(body).not.toContain('\x1b')
		expect(body).not.toContain('\u200b')
	})
})

let sb: Sandbox

describe('schedule history: text vs --json', () => {
	it('the text view is sanitized; --json stays raw', async () => {
		sb = sandbox()
		try {
			const job = confirmedJob(sb)
			const at = new Date().toISOString()
			appendHistory(sb.paths, job.id, {
				v: 1,
				kind: 'run',
				at,
				runId: 'r1',
				key: '1',
				trigger: 'manual',
				startedAt: at,
				endedAt: at,
				status: 'check-failed',
				reason: HOSTILE,
				summary: HOSTILE,
			})
			const text = recordingContext()
			await historyCommand(text, [job.name, '--home', sb.home])
			const printed = String(text.out.printed[0])
			expect(printed).not.toContain('\x07')
			expect(printed).not.toContain('\x1b')
			expect(printed).not.toContain('\u200b')
			expect(printed).toContain('hi')

			const json = recordingContext()
			await historyCommand(json, [job.name, '--home', sb.home, '--json'])
			const payload = JSON.parse(String(json.out.printed[0])) as {
				records: { reason?: string }[]
			}
			expect(payload.records[0]?.reason).toBe(HOSTILE)
		} finally {
			sb.cleanup()
		}
	})
})
