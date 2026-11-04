import { TempDirectoryError } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { plainStartupFailure } from './startup-failure.js'

const full = (path: string, code = 'ENOSPC', syscall = 'mkdir') =>
	Object.assign(new Error(`${code}: no space left on device, ${syscall} '${path}'`), {
		code,
		syscall,
		path,
	})

describe('the start-up line for a disk that is full', () => {
	it('names the folder and how to move it, with no stack and no error code', () => {
		const line = plainStartupFailure(full('/var/tmp/namzu-1000'), () => '/home/a/.namzu')
		expect(line).toBe(
			'The disk is full, so Namzu could not create /var/tmp/namzu-1000. Free some space and start again, or set NAMZU_TMPDIR to a folder on another disk.',
		)
		expect(line).not.toMatch(/ENOSPC|at |\n/)
	})

	it('points at NAMZU_HOME when the folder is inside the Namzu home', () => {
		const line = plainStartupFailure(full('/home/a/.namzu/projects'), () => '/home/a/.namzu')
		expect(line).toContain('set NAMZU_HOME to a folder on another disk')
	})

	it('says the quota when the quota ran out', () => {
		expect(plainStartupFailure(full('/t/x', 'EDQUOT'), () => undefined)).toMatch(
			/^Your disk quota is used up, so Namzu could not create \/t\/x\./,
		)
	})

	it('passes the sentence of a temporary folder that cannot be used through', () => {
		const error = new TempDirectoryError('Namzu could not create /t.', 'not_writable', '/t')
		expect(plainStartupFailure(error, () => undefined)).toBe('Namzu could not create /t.')
	})

	it('leaves everything else to the crash report', () => {
		expect(plainStartupFailure(full('/t/x', 'EACCES'), () => undefined)).toBeUndefined()
		expect(plainStartupFailure(full('/t/x', 'ENOSPC', 'write'), () => undefined)).toBeUndefined()
		expect(plainStartupFailure(new Error('boom'), () => undefined)).toBeUndefined()
		expect(plainStartupFailure(undefined, () => undefined)).toBeUndefined()
	})
})
