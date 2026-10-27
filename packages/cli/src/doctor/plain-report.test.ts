import type { DoctorCheckRecord, DoctorReport } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { describePlainDoctor, plainCheckTitle } from './plain-report.js'

const record = (over: Partial<DoctorCheckRecord> & Pick<DoctorCheckRecord, 'id' | 'status'>) =>
	({ category: 'runtime', durationMs: 7, ...over }) as DoctorCheckRecord

function report(checks: DoctorCheckRecord[]): DoctorReport {
	const count = (s: DoctorCheckRecord['status']) => checks.filter((c) => c.status === s).length
	return {
		version: '1.2.3',
		timestamp: '2026-10-27T00:00:00Z',
		checks,
		summary: {
			pass: count('pass'),
			fail: count('fail'),
			warn: count('warn'),
			inconclusive: count('inconclusive'),
			skipped: count('skipped'),
			total: checks.length,
		},
		exit: 0,
	}
}

describe('the health report in plain words', () => {
	it('says everything passed without ids, timings or exit codes', () => {
		const plain = describePlainDoctor(
			report([
				record({ id: 'sandbox.platform', status: 'pass', message: 'bwrap ok' }),
				record({ id: 'runtime.cwd-writable', status: 'pass' }),
			]),
		)
		expect(plain.level).toBe('notice')
		expect(plain.content).toBe(
			['All 2 checks passed.', '  ✓ Sandbox', '  ✓ This folder is writable'].join('\n'),
		)
		expect(plain.content).not.toMatch(/ms|exit|sandbox\.platform/)
	})

	it('names what needs attention, why, and what to try; the rest is behind the details', () => {
		const plain = describePlainDoctor(
			report([
				record({
					id: 'scheduler.service',
					status: 'fail',
					message: 'Not running.\nmore',
					remediation: 'Start it.\nsecond',
				}),
				record({
					id: 'codeAnalysis.index',
					status: 'inconclusive',
					message: 'timed out after 5000ms',
				}),
				record({ id: 'browser.engine', status: 'skipped', message: 'not installed' }),
			]),
		)
		expect(plain.level).toBe('error')
		expect(plain.content).toBe(
			[
				'2 checks need attention.',
				'  ✗ Scheduled tasks: Not running.',
				'      Try: Start it.',
				'  ? Code index: could not be checked',
			].join('\n'),
		)
		expect(plain.detail).toEqual(['Scheduled tasks:', '  more', '  second'])
	})

	it('warns, rather than errors, when only a warning is raised', () => {
		expect(
			describePlainDoctor(report([record({ id: 'logging.pipeline', status: 'warn' })])).level,
		).toBe('warning')
	})

	it('names an unlisted check from its id', () => {
		expect(plainCheckTitle('custom.my-check')).toBe('My check')
		expect(plainCheckTitle('files.installed')).toBe('Files package')
	})
})
