import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	execFileSync,
}))

import { readClipboardImage } from './image.js'

afterEach(() => {
	vi.unstubAllEnvs()
	execFileSync.mockReset()
})

describe('readClipboardImage under NAMZU_NO_CLIPBOARD', () => {
	it('starts no process and reports the reader unavailable', () => {
		vi.stubEnv('NAMZU_NO_CLIPBOARD', '1')
		execFileSync.mockImplementation(() => {
			throw new Error('a clipboard process was started')
		})
		const read = readClipboardImage()
		expect(execFileSync).not.toHaveBeenCalled()
		expect(read.kind).toBe('unavailable')
	})
})
