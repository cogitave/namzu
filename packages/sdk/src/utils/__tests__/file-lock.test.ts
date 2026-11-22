import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountLockError } from '../../account/types.js'
import {
	EMPTY_LOCK_GRACE_MS,
	FileLockError,
	inspectFileLock,
	lockPathFor,
	withFileLock,
	withFileLockSync,
} from '../file-lock.js'

const dirs: string[] = []
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-file-lock-'))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A pid far above any real one on the test machine, so it reads as an exited process. */
const DEAD_PID = 2 ** 22 + 4321
/** Another process that is alive for the whole test: the one that started this one. */
const LIVE_PID = process.ppid

/** Sets a file's modification time `ms` before now. */
function age(path: string, ms: number): void {
	const at = (Date.now() - ms) / 1000
	utimesSync(path, at, at)
}

describe('file lock', () => {
	it('names the lock beside the file it guards', () => {
		expect(lockPathFor('/a/b/trust.json')).toBe('/a/b/trust.json.lock')
	})

	it('holds the lock with a pid:time:random body during the work and removes it after', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		const body = withFileLockSync(lock, () => readFileSync(lock, 'utf8'))
		expect(body).toMatch(new RegExp(`^${process.pid}:\\d+:[0-9a-f]{24}$`))
		expect(existsSync(lock)).toBe(false)
	})

	it('removes the lock when the work throws', async () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		expect(() =>
			withFileLockSync(lock, () => {
				throw new Error('boom')
			}),
		).toThrow('boom')
		expect(existsSync(lock)).toBe(false)
		await expect(
			withFileLock(lock, async () => {
				throw new Error('later')
			}),
		).rejects.toThrow('later')
		expect(existsSync(lock)).toBe(false)
	})

	it('refuses a lock a live process holds and leaves it in place', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${LIVE_PID}:0:live`)
		const waits: number[] = []
		expect(() =>
			withFileLockSync(lock, () => 'never', { attempts: 3, wait: (n) => void waits.push(n) }),
		).toThrow(FileLockError)
		expect(waits).toEqual([0, 1])
		expect(readFileSync(lock, 'utf8')).toBe(`${LIVE_PID}:0:live`)
	})

	it('reclaims a lock whose process has exited', async () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		expect(withFileLockSync(lock, () => 'ran')).toBe('ran')
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		await expect(withFileLock(lock, async () => 'ran too')).resolves.toBe('ran too')
		expect(existsSync(lock)).toBe(false)
		expect(existsSync(`${lock}.reclaim`)).toBe(false)
	})

	it('does not reclaim while another reclaimer holds the guard', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		writeFileSync(`${lock}.reclaim`, `${process.pid}`)
		expect(() => withFileLockSync(lock, () => 'never')).toThrow(FileLockError)
		expect(readFileSync(lock, 'utf8')).toBe(`${DEAD_PID}:0:dead`)
	})

	it('clears a guard left by an exited reclaimer, so the next attempt reclaims', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		writeFileSync(`${lock}.reclaim`, `${DEAD_PID}`)
		expect(withFileLockSync(lock, () => 'ran', { attempts: 2, wait: () => {} })).toBe('ran')
		expect(existsSync(`${lock}.reclaim`)).toBe(false)
	})

	it('waits for a live holder and runs once the lock is released', async () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${LIVE_PID}:0:live`)
		await expect(
			withFileLock(lock, () => 'ran', {
				attempts: 2,
				wait: async () => rmSync(lock),
			}),
		).resolves.toBe('ran')
	})

	it('never removes a lock that another owner replaced during the work', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		withFileLockSync(lock, () => writeFileSync(lock, 'successor'))
		expect(readFileSync(lock, 'utf8')).toBe('successor')
	})

	it('takes over a lock that never got its body, once it is older than the grace', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, '')
		// Its creator may be writing the body right now: left alone.
		expect(() => withFileLockSync(lock, () => 'never')).toThrow(FileLockError)
		expect(inspectFileLock(lock)).toEqual({ state: 'held' })
		age(lock, EMPTY_LOCK_GRACE_MS + 1000)
		expect(inspectFileLock(lock)).toEqual({ state: 'stale' })
		expect(withFileLockSync(lock, () => 'ran')).toBe('ran')
		expect(existsSync(lock)).toBe(false)
	})

	it('takes over an empty lock whose time is far ahead (the clock went back)', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, '')
		age(lock, -(EMPTY_LOCK_GRACE_MS + 60_000))
		expect(withFileLockSync(lock, () => 'ran')).toBe('ran')
	})

	it('takes over a lock with this process pid that this process does not hold', async () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		// An earlier process with the same pid (a container restart) left it.
		writeFileSync(lock, `${process.pid}:0:left-over`)
		expect(inspectFileLock(lock)).toEqual({ state: 'stale', pid: process.pid })
		expect(withFileLockSync(lock, () => 'ran')).toBe('ran')
		writeFileSync(lock, `${process.pid}:0:left-over`)
		await expect(withFileLock(lock, async () => 'ran too')).resolves.toBe('ran too')
	})

	it('never takes over a lock this process holds, sync or across an await', async () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		expect(
			withFileLockSync(lock, () => {
				expect(inspectFileLock(lock)).toEqual({ state: 'held', pid: process.pid })
				expect(() => withFileLockSync(lock, () => 'nested')).toThrow(FileLockError)
				return 'outer'
			}),
		).toBe('outer')
		let release: () => void = () => {}
		const holding = withFileLock(
			lock,
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		expect(() => withFileLockSync(lock, () => 'never')).toThrow(FileLockError)
		release()
		await holding
		expect(existsSync(lock)).toBe(false)
	})

	it('reports a free lock and a live holder', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		expect(inspectFileLock(lock)).toEqual({ state: 'free' })
		writeFileSync(lock, `${LIVE_PID}:0:live`)
		expect(inspectFileLock(lock)).toEqual({ state: 'held', pid: LIVE_PID })
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		expect(inspectFileLock(lock)).toEqual({ state: 'stale', pid: DEAD_PID })
	})

	it('clears a reclaim guard that never got its body, once it is older than the grace', () => {
		const lock = lockPathFor(join(scratch(), 'state.json'))
		writeFileSync(lock, `${DEAD_PID}:0:dead`)
		writeFileSync(`${lock}.reclaim`, '')
		age(`${lock}.reclaim`, EMPTY_LOCK_GRACE_MS + 1000)
		expect(withFileLockSync(lock, () => 'ran', { attempts: 2, wait: () => {} })).toBe('ran')
	})

	it('keeps the account lock error a file lock error', () => {
		const error = new AccountLockError('/x.lock', 'held')
		expect(error).toBeInstanceOf(FileLockError)
		expect(error.name).toBe('AccountLockError')
		expect(new FileLockError('/x.lock', 'held').name).toBe('FileLockError')
	})
})
