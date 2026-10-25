import { describe, expect, it } from 'vitest'

import { describeShellEscape, describeShellEscapeForModel } from './shell-escape.js'

const base = { output: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 40 }

describe('describeShellEscape', () => {
	it('says a command finished', () => {
		expect(describeShellEscape('ls', base)).toBe('ls finished (exit 0)')
	})

	it('says when the output was shortened', () => {
		expect(describeShellEscape('ls', { ...base, truncated: true })).toBe(
			'ls finished (exit 0, output shortened)',
		)
	})

	it('says a command failed with its exit code', () => {
		expect(describeShellEscape('make', { ...base, exitCode: 2 })).toBe('make failed (exit 2)')
	})

	it('says a command that ran too long was stopped', () => {
		expect(
			describeShellEscape('sleep 99', {
				...base,
				exitCode: null,
				timedOut: true,
				durationMs: 30_000,
			}),
		).toBe('sleep 99 was stopped after 30s')
	})

	it('keeps the row to one short line', () => {
		const row = describeShellEscape(`echo ${'x'.repeat(200)}\nsecond line`, base)
		expect(row).not.toContain('\n')
		expect(row.length).toBeLessThan(90)
	})

	it('still gives the model the state it always had', () => {
		expect(describeShellEscapeForModel('make', { ...base, exitCode: 2, output: 'boom\n' })).toBe(
			'$ make\nboom\n(exit 2)',
		)
	})
})
