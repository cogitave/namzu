import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

// A hook that runs while the password is being hashed: whatever another process does at that moment.
const hooks = vi.hoisted(() => ({ during: undefined as undefined | (() => void) }))
vi.mock('node:crypto', async (orig) => {
	const real = await orig<typeof import('node:crypto')>()
	return {
		...real,
		scryptSync: (...a: Parameters<typeof real.scryptSync>) => {
			const h = hooks.during
			hooks.during = undefined
			h?.()
			return real.scryptSync(...a)
		},
	}
})

const { AdminLock, LOCK_FILE } = await import('./lock.js')
const { ExtensionStore } = await import('./store.js')

const ID = 'com.example.lock-parallel'
const PW = 'correct horse battery'
let home: string
let clock: number

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-lock-par-'))
	clock = Date.parse('2026-06-01T00:00:00Z')
})
afterEach(() => removeTempDir(home))

const make = () => {
	const store = new ExtensionStore(home, () => clock)
	const lock = new AdminLock(store, () => clock)
	return { store, lock }
}
const codeOf = (fn: () => void): string => {
	try {
		fn()
		return 'ok'
	} catch (e) {
		return (e as { code?: string }).code ?? 'other'
	}
}

describe('the wait is written before the password is hashed', () => {
	it('a second attempt that starts while the first is hashing meets the wait', () => {
		const a = make()
		const b = make()
		a.lock.set(ID, PW)
		let during = ''
		hooks.during = () => {
			// another process, at the moment the first one hashes its guess
			during = codeOf(() => b.lock.require(ID, 'another guess here'))
			const rec = JSON.parse(readFileSync(a.store.file(ID, LOCK_FILE), 'utf8'))
			expect(rec.fails).toBe(1)
			expect(rec.waitUntil).toBe(clock + 1000)
		}
		expect(codeOf(() => a.lock.require(ID, 'a wrong guess'))).toBe('admin-wrong')
		expect(during).toBe('admin-wait')
		// the second guess was never judged: only one wrong password is counted
		expect(JSON.parse(readFileSync(a.store.file(ID, LOCK_FILE), 'utf8')).fails).toBe(1)
	})

	it('a right password clears the reserved wait', () => {
		const a = make()
		a.lock.set(ID, PW)
		expect(codeOf(() => a.lock.require(ID, PW))).toBe('ok')
		const rec = JSON.parse(readFileSync(a.store.file(ID, LOCK_FILE), 'utf8'))
		expect(rec.fails).toBe(0)
		expect(rec.waitUntil).toBe(0)
		expect(a.lock.state(ID)).toEqual({ locked: true })
	})

	it('the guard file is gone afterwards, and one left behind by a dead process is taken over', () => {
		const a = make()
		a.lock.set(ID, PW)
		expect(codeOf(() => a.lock.require(ID, PW))).toBe('ok')
		const guard = join(a.store.dir(ID), 'lock.json.guard')
		expect(existsSync(guard)).toBe(false)
		mkdirSync(a.store.dir(ID), { recursive: true })
		writeFileSync(guard, '')
		const old = new Date(Date.now() - 60_000)
		utimesSync(guard, old, old)
		expect(codeOf(() => a.lock.require(ID, PW))).toBe('ok')
		expect(existsSync(guard)).toBe(false)
	})
})
