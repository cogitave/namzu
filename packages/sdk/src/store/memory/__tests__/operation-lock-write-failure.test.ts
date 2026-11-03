import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

let failStat = false
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args)
			if (failStat) {
				handle.stat = async () => {
					throw Object.assign(new Error('stat failed'), { code: 'EIO' })
				}
			} else {
				handle.writeFile = async () => {
					throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
				}
			}
			return handle
		},
	}
})

const { acquireMemoryOperationLock } = await import('../operation-lock.js')

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

describe('memory operation lock creation failures', () => {
	it.each([false, true])('leaves no lock file behind (stat failure: %s)', async (statFails) => {
		failStat = statFails
		const dir = await mkdtemp(join(tmpdir(), 'namzu-memory-lock-fail-'))
		roots.push(dir)
		const path = join(dir, 'operation.lock')
		await expect(acquireMemoryOperationLock(path, 25)).rejects.toMatchObject({
			code: statFails ? 'EIO' : 'ENOSPC',
		})
		await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
	})
})
