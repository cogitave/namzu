import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	acquireUpdateLock,
	installScope,
	previousDir,
	pruneOlderPrevious,
	readCheck,
	readLastResult,
	updatesDir,
	writeCheck,
	writeLastResult,
} from './state.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-update-state-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the update lock', () => {
	it('is held by one process at a time and released by its owner', () => {
		const first = acquireUpdateLock({ home, pid: 100, isAlive: () => true })
		expect(first).not.toBeNull()
		expect(acquireUpdateLock({ home, pid: 200, isAlive: () => true })).toBeNull()
		first?.release()
		const second = acquireUpdateLock({ home, pid: 200, isAlive: () => true })
		expect(second).not.toBeNull()
		second?.release()
	})

	it('is taken over when the holder is gone', () => {
		acquireUpdateLock({ home, pid: 100, isAlive: () => true })
		expect(acquireUpdateLock({ home, pid: 200, isAlive: (pid) => pid !== 100 })).not.toBeNull()
	})

	it('is taken over when it is older than fifteen minutes even if the pid lives on', () => {
		let clock = 1_000
		acquireUpdateLock({ home, pid: 100, now: () => clock, isAlive: () => true })
		clock += 14 * 60_000
		expect(acquireUpdateLock({ home, pid: 200, now: () => clock, isAlive: () => true })).toBeNull()
		clock += 2 * 60_000
		expect(
			acquireUpdateLock({ home, pid: 200, now: () => clock, isAlive: () => true }),
		).not.toBeNull()
	})

	it('is not released by a process that no longer owns it', () => {
		const first = acquireUpdateLock({ home, pid: 100, isAlive: () => true })
		const second = acquireUpdateLock({ home, pid: 200, isAlive: (pid) => pid !== 100 })
		expect(second).not.toBeNull()
		// The first holder was replaced as stale; its late release must not free the new holder.
		first?.release()
		expect(acquireUpdateLock({ home, pid: 300, isAlive: () => true })).toBeNull()
	})

	it('treats a damaged lock file as stale', () => {
		const dir = join(updatesDir(home), 'locks', 'shared')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, '1'), 'not json')
		expect(acquireUpdateLock({ home, pid: 200, isAlive: () => true })).not.toBeNull()
	})

	it('lets exactly one of two processes that both found the same stale holder take over', () => {
		acquireUpdateLock({ home, pid: 100, isAlive: () => true })
		let winner: ReturnType<typeof acquireUpdateLock> | undefined
		// The second process has judged the holder gone but has not yet taken over when the first
		// one finishes taking over: it is the first one's lock it meets when it tries.
		const loser = acquireUpdateLock({
			home,
			pid: 300,
			isAlive: (pid) => {
				if (pid === 100) {
					winner ??= acquireUpdateLock({ home, pid: 200, isAlive: (other) => other !== 100 })
					return false
				}
				return true
			},
		})
		expect(winner).not.toBeNull()
		expect(loser).toBeNull()
		winner?.release()
		expect(acquireUpdateLock({ home, pid: 400, isAlive: () => true })).not.toBeNull()
	})

	it('never hands out a number twice, so a late process cannot take over a lock that was released', () => {
		const dir = join(updatesDir(home), 'locks', 'shared')
		const seen: string[] = []
		for (let round = 0; round < 3; round += 1) {
			acquireUpdateLock({ home, pid: 100 + round, isAlive: () => true })?.release()
			seen.push(...readdirSync(dir))
		}
		// One file is kept, and it is always a higher number than the one before.
		expect(seen).toEqual(['1', '2', '3'])
	})

	it('is kept apart for each install', () => {
		const a = acquireUpdateLock({ home, scope: 'aaaa', pid: 100, isAlive: () => true })
		const b = acquireUpdateLock({ home, scope: 'bbbb', pid: 200, isAlive: () => true })
		expect(a).not.toBeNull()
		expect(b).not.toBeNull()
		expect(acquireUpdateLock({ home, scope: 'aaaa', pid: 300, isAlive: () => true })).toBeNull()
	})

	it('names an install by where it is, the same way each time', () => {
		expect(installScope('/home/a/.nvm/v22', 'linux')).toBe(
			installScope('/home/a/.nvm/v22/', 'linux'),
		)
		expect(installScope('/home/a/.nvm/v22', 'linux')).not.toBe(installScope('/usr', 'linux'))
		expect(installScope('C:\\Users\\A\\npm', 'win32')).toBe(
			installScope('c:\\users\\a\\NPM', 'win32'),
		)
	})
})

describe('the kept records', () => {
	it('round-trips the last look and reads a damaged file as absent', () => {
		expect(readCheck(home)).toBeUndefined()
		writeCheck(home, { at: 5, channel: 'latest', version: '2.0.0', integrity: 'sha512-AAAA' })
		expect(readCheck(home)).toEqual({
			at: 5,
			channel: 'latest',
			version: '2.0.0',
			integrity: 'sha512-AAAA',
		})
		writeFileSync(join(updatesDir(home), 'check.json'), '{')
		expect(readCheck(home)).toBeUndefined()
	})

	it('round-trips the last result', () => {
		const result = {
			at: '2026-10-27T10:00:00.000Z',
			outcome: 'failed' as const,
			status: 'no_permission',
			method: 'npm-global',
			from: '1.0.0',
			to: '2.0.0',
			detail: 'x',
		}
		writeLastResult(home, result)
		expect(readLastResult(home)).toEqual(result)
		expect(readFileSync(join(updatesDir(home), 'last-result.json'), 'utf8').endsWith('\n')).toBe(
			true,
		)
	})
})

describe('kept previous versions', () => {
	it('keeps the two newest and removes the rest', () => {
		for (const [index, version] of ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].entries()) {
			const dir = previousDir(home, version)
			mkdirSync(dir, { recursive: true })
			const time = new Date(2026, 0, 1 + index)
			utimesSync(dir, time, time)
		}
		pruneOlderPrevious(home)
		expect(existsSync(previousDir(home, '1.0.0'))).toBe(false)
		expect(existsSync(previousDir(home, '1.1.0'))).toBe(false)
		expect(existsSync(previousDir(home, '1.2.0'))).toBe(true)
		expect(existsSync(previousDir(home, '1.3.0'))).toBe(true)
	})
})
