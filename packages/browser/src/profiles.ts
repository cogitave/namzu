import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ProfileBusyError } from './errors.js'

/**
 * Browser profiles and the leases on them, under `NAMZU_HOME/browser`:
 *
 * ```text
 * browser/
 *   profiles/<name>.json    the descriptor
 *   profiles/<name>/        the browser's user data directory (0700)
 *   leases/<name>/<pid>-<session>.json
 * ```
 *
 * A profile is where a site's sign-in lives: the operator signs in once in
 * a visible window, and every later run reuses the cookies. Every directory
 * here is created 0700, because what is inside is as good as a password.
 */

/** Profile names: lowercase words joined by single hyphens. */
export const BROWSER_PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const DEFAULT_BROWSER_PROFILE = 'default'

export interface BrowserProfileDescriptor {
	readonly v: 1
	readonly name: string
	/** The engine whose browser owns the user data directory. */
	readonly engine: 'local' | 'windows-cdp'
	/** The browser's user data directory, in the engine's own path syntax. */
	readonly userDataDir: string
	/** `chrome`, `msedge` or `chromium`. */
	readonly browser: string
	readonly createdAt: string
	readonly lastLoginAt?: string
}

export class BrowserProfileError extends Error {
	override readonly name = 'BrowserProfileError'
}

function assertName(name: string): void {
	if (name.length > 64 || !BROWSER_PROFILE_NAME.test(name)) {
		throw new BrowserProfileError(
			`"${name}" is not a profile name: use lowercase letters, digits and single hyphens, at most 64 characters.`,
		)
	}
}

function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new BrowserProfileError(`${path} is not a real directory.`)
	}
	if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) chmodSync(path, 0o700)
}

function writeJsonAtomic(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
	renameSync(temp, path)
}

function isDescriptor(value: unknown, name: string): value is BrowserProfileDescriptor {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	return (
		v.v === 1 &&
		v.name === name &&
		(v.engine === 'local' || v.engine === 'windows-cdp') &&
		typeof v.userDataDir === 'string' &&
		typeof v.browser === 'string' &&
		typeof v.createdAt === 'string'
	)
}

export class BrowserProfileStore {
	readonly root: string

	/** `home` is `NAMZU_HOME`. */
	constructor(readonly home: string) {
		this.root = join(home, 'browser', 'profiles')
	}

	/** Where a local engine keeps this profile's user data. */
	localUserDataDir(name: string): string {
		assertName(name)
		return join(this.root, name)
	}

	get(name: string): BrowserProfileDescriptor | undefined {
		assertName(name)
		let text: string
		try {
			text = readFileSync(join(this.root, `${name}.json`), 'utf8')
		} catch {
			return undefined
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new BrowserProfileError(`The descriptor of browser profile "${name}" is not JSON.`)
		}
		if (!isDescriptor(parsed, name)) {
			throw new BrowserProfileError(`The descriptor of browser profile "${name}" is not readable.`)
		}
		return parsed
	}

	list(): BrowserProfileDescriptor[] {
		let entries: string[]
		try {
			entries = readdirSync(this.root)
		} catch {
			return []
		}
		const out: BrowserProfileDescriptor[] = []
		for (const entry of entries.sort()) {
			if (!entry.endsWith('.json')) continue
			const name = entry.slice(0, -'.json'.length)
			if (!BROWSER_PROFILE_NAME.test(name)) continue
			try {
				const descriptor = this.get(name)
				if (descriptor) out.push(descriptor)
			} catch {
				// An unreadable descriptor is skipped in a listing; `get` reports it.
			}
		}
		return out
	}

	/**
	 * The profile's descriptor, created with a 0700 local user data directory
	 * when it does not exist yet.
	 */
	ensureLocal(name: string, browser: string, now: Date = new Date()): BrowserProfileDescriptor {
		const existing = this.get(name)
		if (existing) {
			if (existing.engine !== 'local') {
				throw new BrowserProfileError(
					`Browser profile "${name}" belongs to the ${existing.engine} engine, not this local browser. Use another profile name.`,
				)
			}
			ensurePrivateDir(existing.userDataDir)
			return existing
		}
		ensurePrivateDir(join(this.home, 'browser'))
		ensurePrivateDir(this.root)
		const userDataDir = this.localUserDataDir(name)
		ensurePrivateDir(userDataDir)
		const descriptor: BrowserProfileDescriptor = {
			v: 1,
			name,
			engine: 'local',
			userDataDir,
			browser,
			createdAt: now.toISOString(),
		}
		writeJsonAtomic(join(this.root, `${name}.json`), descriptor)
		return descriptor
	}

	/** Record a completed sign-in. */
	markLogin(name: string, now: Date = new Date()): BrowserProfileDescriptor {
		const existing = this.get(name)
		if (!existing) throw new BrowserProfileError(`There is no browser profile "${name}".`)
		const next = { ...existing, lastLoginAt: now.toISOString() }
		writeJsonAtomic(join(this.root, `${name}.json`), next)
		return next
	}

	/**
	 * Delete the descriptor and, for a local profile, its user data. Refused
	 * while any live process holds a lease on it.
	 */
	remove(name: string, leases: BrowserLeaseStore = new BrowserLeaseStore(this.home)): boolean {
		const existing = this.get(name)
		if (!existing) return false
		const holders = leases.holders(name)
		if (holders.length > 0) throw new ProfileBusyError(name, holders)
		if (existing.engine === 'local') {
			rmSync(existing.userDataDir, { recursive: true, force: true })
		}
		rmSync(join(this.root, `${name}.json`), { force: true })
		return true
	}
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export interface BrowserLeaseRecord {
	readonly v: 1
	readonly profile: string
	readonly pid: number
	readonly session: string
	readonly acquiredAt: string
}

/** A held lease. `release` returns whether it was the last live one on the profile. */
export interface BrowserLease {
	readonly profile: string
	readonly id: string
	release(): { last: boolean }
}

/** Is `pid` a live process? A process we may not signal is alive. */
export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

export class BrowserLeaseStore {
	readonly root: string

	constructor(
		readonly home: string,
		private readonly alive: (pid: number) => boolean = processAlive,
	) {
		this.root = join(home, 'browser', 'leases')
	}

	private dir(profile: string): string {
		assertName(profile)
		return join(this.root, profile)
	}

	/** Live leases on `profile`, as `<pid>-<session>`. Stale ones are removed on the way. */
	holders(profile: string): string[] {
		const dir = this.dir(profile)
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return []
		}
		const live: string[] = []
		for (const entry of entries.sort()) {
			const match = /^(\d+)-([A-Za-z0-9_-]+)\.json$/.exec(entry)
			if (!match) continue
			if (this.alive(Number(match[1]))) live.push(`${match[1]}-${match[2]}`)
			else rmSync(join(dir, entry), { force: true })
		}
		return live
	}

	/**
	 * Take a lease for this process and `session`. With `exclusive`, any live
	 * lease by another holder — another process, or another session of this
	 * one — is a {@link ProfileBusyError}: a local profile directory can be
	 * open in one browser at a time.
	 */
	acquire(
		profile: string,
		session: string,
		options: { exclusive?: boolean; pid?: number; now?: Date } = {},
	): BrowserLease {
		if (!SESSION_ID.test(session)) {
			throw new BrowserProfileError(`"${session}" is not a usable session id for a lease.`)
		}
		const pid = options.pid ?? process.pid
		const id = `${pid}-${session}`
		const dir = this.dir(profile)
		ensurePrivateDir(join(this.home, 'browser'))
		ensurePrivateDir(this.root)
		ensurePrivateDir(dir)
		const record: BrowserLeaseRecord = {
			v: 1,
			profile,
			pid,
			session,
			acquiredAt: (options.now ?? new Date()).toISOString(),
		}
		const path = join(dir, `${id}.json`)
		writeJsonAtomic(path, record)
		// Written first, checked second: two processes racing both see each
		// other and both refuse, rather than both seeing nothing.
		if (options.exclusive) {
			const others = this.holders(profile).filter((holder) => holder !== id)
			if (others.length > 0) {
				rmSync(path, { force: true })
				throw new ProfileBusyError(profile, others)
			}
		}
		let released = false
		return {
			profile,
			id,
			release: () => {
				if (!released) {
					released = true
					rmSync(path, { force: true })
				}
				return { last: this.holders(profile).length === 0 }
			},
		}
	}
}
