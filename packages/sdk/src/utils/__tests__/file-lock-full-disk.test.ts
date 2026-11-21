import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return { ...actual, writeSync: vi.fn(actual.writeSync) }
})

import { lockPathFor, withFileLockSync } from '../file-lock.js'

const dirs: string[] = []
afterEach(() => {
	vi.mocked(fs.writeSync).mockClear()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('file lock on a full disk', () => {
	it('removes the lock it created when its body cannot be written, so the next change gets it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-file-lock-full-'))
		dirs.push(dir)
		const lock = lockPathFor(join(dir, 'trust.json'))
		vi.mocked(fs.writeSync).mockImplementationOnce(() => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
		})
		expect(() => withFileLockSync(lock, () => 'never')).toThrow('ENOSPC')
		expect(existsSync(lock)).toBe(false)
		// The disk has room again: the next change is not refused by a lock left behind.
		expect(withFileLockSync(lock, () => 'ran')).toBe('ran')
	})
})
