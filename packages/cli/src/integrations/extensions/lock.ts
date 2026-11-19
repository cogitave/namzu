import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, openSync, rmSync, statSync } from 'node:fs'
import { ExtensionError } from './errors.js'
import type { ExtensionStore } from './store.js'

/**
 * The administrator lock. An extension that declares `management.lock` is turned on with an administrator
 * password; while it is set, turning the extension off, removing it, turning off its start at sign-in,
 * changing or releasing its licence, taking a permission back and changing its keys need that password.
 *
 * Only a slow salted hash is kept (Node's scrypt, a random salt for each extension), in `lock.json` in the
 * extension's own host folder. That file is not in the extension's data folder and Namzu never hands its
 * path to the extension. This stops turning it off *in Namzu*. It is not a protection against someone who
 * is an administrator of the computer and deletes files or ends processes: that needs the managed policy
 * of a later phase, and the docs say so.
 */

export const LOCK_FILE = 'lock.json'
const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 128 * 1024 * 1024 } as const
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 256
const WAIT_BASE_MS = 1000
const WAIT_MAX_MS = 60_000
/** The file that serialises attempts across processes, and how long one may be held before it is taken as left behind. */
const GUARD_FILE = 'lock.json.guard'
const GUARD_STALE_MS = 10_000
const GUARD_TRIES = 400
const GUARD_PAUSE_MS = 25

const pause = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface LockRecord {
	schema: 1
	kdf: 'scrypt'
	N: number
	r: number
	p: number
	salt: string
	hash: string
	setAt: number
	/** Wrong passwords since the last right one. */
	fails: number
	/** No attempt is looked at before this time. */
	waitUntil: number
}

export interface LockState {
	readonly locked: boolean
	/** Seconds until another try is looked at; absent when none is being waited for. */
	readonly waitSeconds?: number
}

const derive = (password: string, salt: Buffer, p: Pick<LockRecord, 'N' | 'r' | 'p'>): Buffer =>
	scryptSync(password.normalize('NFC'), salt, SCRYPT.keyLen, {
		N: p.N,
		r: p.r,
		p: p.p,
		maxmem: SCRYPT.maxmem,
	})

/** The wait after the n-th wrong password in a row: 1 s, 2 s, 4 s, up to a minute. */
export const waitAfter = (fails: number): number =>
	Math.min(WAIT_MAX_MS, WAIT_BASE_MS * 2 ** Math.max(0, fails - 1))

/** "1 second", "2 seconds": the wait in words a person reads. */
export function secondsWord(ms: number): string {
	const n = Math.max(1, Math.ceil(ms / 1000))
	return n === 1 ? '1 second' : `${n} seconds`
}

export class AdminLock {
	constructor(
		private readonly store: ExtensionStore,
		private readonly now: () => number,
	) {}

	private read(id: string): LockRecord | undefined {
		const r = this.store.readJson<LockRecord>(id, LOCK_FILE)
		return r && r.schema === 1 && typeof r.hash === 'string' && typeof r.salt === 'string'
			? r
			: undefined
	}

	state(id: string): LockState {
		const r = this.read(id)
		if (!r) return { locked: false }
		const left = r.waitUntil - this.now()
		return left > 0 ? { locked: true, waitSeconds: Math.ceil(left / 1000) } : { locked: true }
	}

	/** A short refusal a person can act on; the password itself is never in a message. */
	static checkNew(password: string): void {
		if (password.length < MIN_PASSWORD)
			throw new ExtensionError(
				'admin-weak',
				'lock',
				`The administrator password needs at least ${MIN_PASSWORD} characters.`,
			)
		if (password.length > MAX_PASSWORD)
			throw new ExtensionError('admin-weak', 'lock', 'That administrator password is too long.')
	}

	set(id: string, password: string): void {
		AdminLock.checkNew(password)
		const salt = randomBytes(16)
		const rec: LockRecord = {
			schema: 1,
			kdf: 'scrypt',
			N: SCRYPT.N,
			r: SCRYPT.r,
			p: SCRYPT.p,
			salt: salt.toString('hex'),
			hash: derive(password, salt, SCRYPT).toString('hex'),
			setAt: this.now(),
			fails: 0,
			waitUntil: 0,
		}
		this.store.writeJson(id, LOCK_FILE, rec, 0o600)
	}

	/**
	 * Nothing when there is no lock or the password is right. Otherwise an ExtensionError: `admin-locked`
	 * when no password was given, `admin-wait` while a wait runs (the password is not even looked at), and
	 * `admin-wrong` for a wrong one, which also lengthens the wait.
	 */
	require(id: string, password: string | undefined): void {
		const r = this.read(id)
		if (!r) return
		if (password === undefined || password === '')
			throw new ExtensionError(
				'admin-locked',
				'lock',
				'This extension is locked by your administrator. Enter the administrator password.',
			)
		// The attempt is counted and its wait is written before the password is hashed. Fifty processes that
		// start at once each find the wait the one before reserved, so the hash is no longer the limit.
		const fails = this.reserve(id)
		const ok =
			password.length <= MAX_PASSWORD &&
			(() => {
				const want = Buffer.from(r.hash, 'hex')
				const got = derive(password, Buffer.from(r.salt, 'hex'), r)
				return want.length === got.length && timingSafeEqual(want, got)
			})()
		if (ok) {
			this.update(id, (cur) => ({ ...cur, fails: 0, waitUntil: 0 }))
			return
		}
		throw new ExtensionError(
			'admin-wrong',
			'lock',
			`That is not the administrator password. Wait ${secondsWord(waitAfter(fails))} to try again.`,
		)
	}

	/** Run `fn` while this process alone holds the extension's guard file; a left-behind one is taken over. */
	private exclusive<T>(id: string, fn: () => T): T {
		const f = this.store.file(id, GUARD_FILE)
		for (let i = 0; ; i++) {
			try {
				closeSync(openSync(f, 'wx', 0o600))
				break
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
				try {
					if (Date.now() - statSync(f).mtimeMs > GUARD_STALE_MS) rmSync(f, { force: true })
				} catch {
					// it went away between the two calls
				}
				if (i >= GUARD_TRIES)
					throw new ExtensionError(
						'admin-wait',
						'lock',
						'Another attempt is being checked. Try again in a moment.',
					)
				pause(GUARD_PAUSE_MS)
			}
		}
		try {
			return fn()
		} finally {
			rmSync(f, { force: true })
		}
	}

	/** Re-read the record under the guard and write the changed one. */
	private update(id: string, change: (r: LockRecord) => LockRecord): void {
		this.exclusive(id, () => {
			const cur = this.read(id)
			if (cur) this.store.writeJson(id, LOCK_FILE, change(cur), 0o600)
		})
	}

	/**
	 * Take the attempt: refuse while a wait runs, else count it and write the next wait now. Returns the
	 * number of wrong passwords in a row this attempt stands for (the right one clears it).
	 */
	private reserve(id: string): number {
		return this.exclusive(id, () => {
			const cur = this.read(id)
			if (!cur) return 0
			const left = cur.waitUntil - this.now()
			if (left > 0)
				throw new ExtensionError(
					'admin-wait',
					'lock',
					`Wait ${secondsWord(left)} before trying the administrator password again.`,
				)
			const fails = cur.fails + 1
			this.store.writeJson(
				id,
				LOCK_FILE,
				{ ...cur, fails, waitUntil: this.now() + waitAfter(fails) },
				0o600,
			)
			return fails
		})
	}

	/** Drop the lock. The caller has already made it pass `require`. */
	clear(id: string): void {
		const f = this.store.file(id, LOCK_FILE)
		if (existsSync(f)) rmSync(f, { force: true })
	}
}
