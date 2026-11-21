import { describe, expect, it } from 'vitest'

import { jobExitRow, jobLabel } from '../job-exit-row.js'
import { tokenColor } from '../theme.js'

describe('the row for a finished background command', () => {
	it('says finished in green with the runtime', () => {
		expect(
			jobExitRow({ command: 'npm test', status: 'exited', exitCode: 0, runtimeMs: 12_000 }),
		).toEqual({
			text: 'Background command "npm test" finished (exit code 0)',
			color: tokenColor('status.ok'),
			meta: '12s',
		})
	})

	it('says failed with the exit code in red', () => {
		const row = jobExitRow({ command: 'make', status: 'exited', exitCode: 2 })
		expect(row.text).toBe('Background command "make" failed with exit code 2')
		expect(row.color).toBe(tokenColor('status.error'))
		expect(row.meta).toBeUndefined()
	})

	it('names a signal when there is no exit code', () => {
		expect(jobExitRow({ command: 'x', status: 'exited', signal: 'SIGSEGV' }).text).toContain(
			'failed with signal SIGSEGV',
		)
	})

	it('says stopped in yellow', () => {
		const row = jobExitRow({ command: 'sleep 99', status: 'killed' })
		expect(row.text).toBe('Background command "sleep 99" was stopped')
		expect(row.color).toBe(tokenColor('status.warn'))
	})

	it('shows only the first line of a long or multi-line command', () => {
		const multi = jobExitRow({ command: 'echo a\necho b', status: 'exited', exitCode: 0 }).text
		expect(multi).toContain('"echo a…"')
		expect(jobExitRow({ command: 'x'.repeat(200), status: 'exited', exitCode: 0 }).text).toContain(
			'…"',
		)
	})

	it('never contains a job id', () => {
		expect(jobExitRow({ command: 'ls', status: 'exited', exitCode: 0 }).text).not.toMatch(
			/\bb[0-9a-z]{8}\b/,
		)
	})
})

describe('what a background command is called', () => {
	it("uses the call's own description when it has one", () => {
		const row = jobExitRow({
			command: 'cd /tmp/some/long/project/path && npm test 2>&1 | tail -80',
			description: 'Run full test suite in background',
			status: 'exited',
			exitCode: 0,
		})
		expect(row.text).toBe(
			'Background command "Run full test suite in background" finished (exit code 0)',
		)
	})

	it('drops a leading cd into the project from the command it falls back to', () => {
		expect(jobLabel({ command: 'cd /tmp/work/proj && npm test' })).toBe('npm test')
		expect(jobLabel({ command: "cd '/tmp/my proj'; npm run build" })).toBe('npm run build')
		expect(jobLabel({ command: 'cd "/tmp/my proj" && ls -la' })).toBe('ls -la')
	})

	it('keeps a command that is only a cd, and one that has no cd', () => {
		expect(jobLabel({ command: 'cd /tmp/work' })).toBe('cd /tmp/work')
		expect(jobLabel({ command: 'make -j4' })).toBe('make -j4')
	})

	it('ignores a blank description', () => {
		expect(jobLabel({ command: 'make', description: '   ' })).toBe('make')
	})
})
