import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A crash between "the temp file is written" and "it is renamed into place" is
// stood in for by a rename that fails: the target must still be the old file.
const crash = vi.hoisted(() => ({ on: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...original,
		rename: async (from: string, to: string) => {
			if (crash.on) throw new Error('the process died before the rename')
			return original.rename(from, to)
		},
	}
})

import type { WslcRestartMarker, WslcSetupHost } from '../contract.js'
import { readRestartMarker, writeRestartMarker } from '../restart.js'
import { readImageRecord, writeImageRecord } from '../wslc-shared.js'
import { tempDirectory } from './fakes.js'

let directory: string
let host: WslcSetupHost
beforeEach(async () => {
	crash.on = false
	directory = await tempDirectory()
	host = { stateDirectory: directory } as WslcSetupHost
})
afterEach(async () => {
	crash.on = false
	await rm(directory, { recursive: true, force: true })
})

const OLD: WslcRestartMarker = {
	recordedAt: '2026-10-12T09:00:00.000Z',
	planId: 'old',
	remaining: ['load-image'],
}

describe('state files are replaced atomically', () => {
	it('leaves the old restart marker whole when the write dies before the rename', async () => {
		await writeRestartMarker(host, OLD)
		crash.on = true
		await expect(
			writeRestartMarker(host, { ...OLD, planId: 'new', remaining: [] }),
		).rejects.toThrow('before the rename')
		crash.on = false
		expect(await readRestartMarker(host)).toEqual(OLD)
		expect(JSON.parse(await readFile(join(directory, 'restart.json'), 'utf8'))).toEqual(OLD)
		// The failed write cleans up after itself.
		expect(await readdir(directory)).toEqual(['restart.json'])
	})

	it('leaves no restart marker at all when the very first write dies', async () => {
		crash.on = true
		await expect(writeRestartMarker(host, OLD)).rejects.toThrow()
		crash.on = false
		expect(await readRestartMarker(host)).toBeUndefined()
		expect(await readdir(directory)).toEqual([])
	})

	it('leaves the old image record whole when the write dies before the rename', async () => {
		const first = { imageRef: 'namzu-local-computer:2', imageId: 'sha256:old', loadedAt: 'then' }
		await writeImageRecord(host, first)
		crash.on = true
		await expect(
			writeImageRecord(host, { ...first, imageId: 'sha256:new', loadedAt: 'now' }),
		).rejects.toThrow('before the rename')
		crash.on = false
		expect(await readImageRecord(host)).toEqual(first)
		expect(await readdir(directory)).toEqual(['image.json'])
	})
})
