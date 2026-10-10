import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { removeTempDir } from './__fixtures__/temp-dir.js'
import { reportCrash } from './crash-report.js'

describe('an unexpected crash', () => {
	it('prints one plain line and keeps the stack in a log file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-crash-'))
		try {
			const text = reportCrash(new Error('secret internals'), {
				dir,
				env: {},
				argv: [],
				now: new Date('2026-10-10T10:00:00Z'),
			})
			expect(text).toMatch(
				/^Namzu stopped because of an unexpected problem\. Details were saved to .*crash-2026-10-10T10-00-00-000Z\.log\.\n$/,
			)
			expect(text).not.toContain('secret internals')
			expect(text).not.toMatch(/\bat .*\(/)
			const [name] = readdirSync(dir)
			expect(readFileSync(join(dir, name ?? ''), 'utf8')).toContain('secret internals')
		} finally {
			removeTempDir(dir)
		}
	})

	it('adds the stack to the screen only on request', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-crash-'))
		try {
			expect(
				reportCrash(new Error('why'), {
					dir,
					env: { NAMZU_DEBUG: '1' },
					argv: [],
				}),
			).toContain('Error: why')
			expect(reportCrash(new Error('why'), { dir, env: {}, argv: ['--debug'] })).toContain(
				'Error: why',
			)
		} finally {
			removeTempDir(dir)
		}
	})

	it('still says something plain when the log cannot be written', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-crash-'))
		try {
			// A file where the folder should be: the log cannot be created under it.
			const blocker = join(root, 'blocker')
			writeFileSync(blocker, 'x')
			const text = reportCrash(new Error('x'), {
				dir: join(blocker, 'logs'),
				env: {},
				argv: [],
			})
			expect(text).toBe(
				'Namzu stopped because of an unexpected problem. Run again with --debug to see details.\n',
			)
		} finally {
			removeTempDir(root)
		}
	})
})
