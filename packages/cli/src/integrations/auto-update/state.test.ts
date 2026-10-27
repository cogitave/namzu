import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	acquireUpdateLock,
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
		expect(existsSync(join(updatesDir(home), 'update.lock'))).toBe(false)
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
		const path = join(updatesDir(home), 'update.lock')
		writeFileSync(path, JSON.stringify({ pid: 999, at: Date.now() }))
		first?.release()
		expect(existsSync(path)).toBe(true)
	})

	it('treats a damaged lock file as stale', () => {
		mkdirSync(updatesDir(home), { recursive: true })
		writeFileSync(join(updatesDir(home), 'update.lock'), 'not json')
		expect(acquireUpdateLock({ home, pid: 200, isAlive: () => true })).not.toBeNull()
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
