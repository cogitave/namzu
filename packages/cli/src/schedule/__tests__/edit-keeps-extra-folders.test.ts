/**
 * `schedule edit` and the extra folders a job may touch: `--add-dir` joins the
 * stored list, and a permissions change that names no list keeps it.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { editCommand } from '../commands/add.js'
import { findJob } from '../store/jobs.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
let first: string
let second: string
beforeEach(() => {
	sb = sandbox()
	first = join(sb.osHome, 'first')
	second = join(sb.osHome, 'second')
	mkdirSync(first, { recursive: true })
	mkdirSync(second, { recursive: true })
})
afterEach(() => {
	__resetCliLoggerForTests()
	sb.cleanup()
})

const stored = () => findJob(sb.paths, 'nightly').permissions.additionalDirectories ?? []

describe('schedule edit extra folders', () => {
	it('--add-dir joins the stored list instead of being dropped', async () => {
		confirmedJob(sb, { permissions: { preset: 'read-only', additionalDirectories: [first] } })
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, ['nightly', '--home', sb.home, '--add-dir', second, '--yes']),
		).toBe(0)
		expect(stored()).toHaveLength(2)
		expect(stored().some((dir) => dir.endsWith('first'))).toBe(true)
		expect(stored().some((dir) => dir.endsWith('second'))).toBe(true)
	})

	it('--permissions that sets no list keeps the stored one', async () => {
		confirmedJob(sb, { permissions: { preset: 'read-only', additionalDirectories: [first] } })
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, [
				'nightly',
				'--home',
				sb.home,
				'--permissions',
				'edit-in-folder',
				'--add-dir',
				second,
				'--yes',
			]),
		).toBe(0)
		expect(stored().map((dir) => dir.split(/[\\/]/).pop())).toEqual(['first', 'second'])
		expect(
			await editCommand(recordingContext(), [
				'nightly',
				'--home',
				sb.home,
				'--permissions',
				'read-only',
				'--yes',
			]),
		).toBe(0)
		expect(stored().map((dir) => dir.split(/[\\/]/).pop())).toEqual(['first', 'second'])
	})

	it('a permissions file that sets a list replaces the stored one', async () => {
		confirmedJob(sb, { permissions: { preset: 'read-only', additionalDirectories: [first] } })
		const file = join(sb.root, 'perm.json')
		writeFileSync(file, JSON.stringify({ preset: 'read-only', additionalDirectories: [second] }))
		expect(
			await editCommand(recordingContext(), [
				'nightly',
				'--home',
				sb.home,
				'--permissions',
				file,
				'--yes',
			]),
		).toBe(0)
		expect(stored().map((dir) => dir.split(/[\\/]/).pop())).toEqual(['second'])
	})
})
