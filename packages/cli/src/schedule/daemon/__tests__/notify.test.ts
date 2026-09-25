import { describe, expect, it } from 'vitest'
import { NOTICE_BODY_MAX, noticeText, scriptSummaryOf } from '../notify.js'

const AT = new Date('2026-09-24T12:00:00Z')

function job(includeSummary: boolean) {
	return {
		name: 'ticker',
		notify: { finished: true, failed: true, awaitingApproval: true, includeSummary },
	}
}

describe('noticeText: check-failed', () => {
	it('says nothing about the reason when the job did not ask for a summary', () => {
		const { body } = noticeText('check-failed', job(false), {
			at: AT,
			reason: 'the wake-gate script exited 9',
		})
		expect(body).not.toContain('exited 9')
		expect(body).toContain('check failed')
		expect(body).toContain('namzu schedule show ticker')
	})

	it('shows the reason when the job asked for a summary', () => {
		const { body } = noticeText('check-failed', job(true), {
			at: AT,
			reason: 'the wake-gate script exited 9',
		})
		expect(body).toContain('exited 9')
	})

	it('fits the notification body cap even with a long reason', () => {
		const { body } = noticeText('check-failed', job(true), {
			at: AT,
			reason: 'x'.repeat(1000),
		})
		expect([...body].length).toBeLessThanOrEqual(NOTICE_BODY_MAX)
	})
})

describe('scriptSummaryOf', () => {
	it('is undefined with no script output', () => {
		expect(scriptSummaryOf({})).toBeUndefined()
	})

	it('is the last non-JSON line of stdout', () => {
		expect(scriptSummaryOf({ scriptOutput: { stdout: 'checking...\nall good\n' } })).toBe(
			'all good',
		)
	})

	it('skips a trailing wake-gate contract line', () => {
		expect(
			scriptSummaryOf({
				scriptOutput: { stdout: 'disk ok\n{"wake":false,"context":""}\n' },
			}),
		).toBe('disk ok')
	})

	it('is undefined when every line looks like the contract', () => {
		expect(
			scriptSummaryOf({ scriptOutput: { stdout: '{"wake":false,"context":""}\n' } }),
		).toBeUndefined()
	})
})
