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
				'  ✗ Scheduled tasks: scheduled tasks cannot run right now',
				'      Try: Run "namzu schedule install".',
				'  ? Code index: could not be checked',
			].join('\n'),
		)
		expect(plain.detail).toEqual([
			'Scheduled tasks:',
			'  Not running.',
			'  more',
			'  Start it.',
			'  second',
			'Code index:',
			'  timed out after 5000ms',
		])
	})

	it('keeps paths, error text and jargon out of the rows for the real check messages', () => {
		const plain = describePlainDoctor(
			report([
				record({
					id: 'runtime.cwd-writable',
					status: 'fail',
					message: 'cwd not writable: /home/a/b (EACCES)',
					remediation: 'Run from a directory you have write access to, or pass an explicit cwd.',
				}),
				record({
					id: 'runtime.invariants',
					status: 'fail',
					message: '2/5 invariant(s) violated — x',
				}),
				record({
					id: 'logging.pipeline',
					status: 'warn',
					message: '3 log record(s) never reached the sink — y',
				}),
				record({
					id: 'sandbox.platform',
					status: 'warn',
					message: 'bwrap enforces nothing — commands run unconfined',
				}),
				record({
					id: 'browser.engine',
					status: 'fail',
					message: '@namzu/browser failed to load: boom',
				}),
				record({
					id: 'providers.credentials',
					status: 'fail',
					message: 'credential discovery failed: ENOENT /x',
				}),
				record({
					id: 'scheduler.service',
					status: 'warn',
					message: 'the scheduler service starts /usr/bin/x, which no longer exists',
				}),
			]),
		)
		expect(plain.content).not.toMatch(/\/|\(s\)|unconfined|EACCES|ENOENT|@namzu|cwd|failed to load/)
		expect(plain.detail.join('\n')).toContain('/home/a/b')
	})

	it('names the updates check and says in words when an update cannot be installed', () => {
		const plain = describePlainDoctor(
			report([
				record({
					id: 'updates.install',
					status: 'warn',
					message: 'Namzu 9.9.9 is available, but the folder is read-only (/opt/namzu)',
					remediation: 'Run: npm install -g @namzu/cli',
				}),
			]),
		)
		expect(plain.content).toContain('! Updates: a newer version could not be installed here')
		expect(plain.content).not.toMatch(/updates\.install|\/opt/)
		expect(plain.detail.join('\n')).toContain('/opt/namzu')
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
