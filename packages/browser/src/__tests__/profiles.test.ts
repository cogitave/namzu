import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProfileBusyError } from '../errors.js'
import { BrowserLeaseStore, BrowserProfileError, BrowserProfileStore } from '../profiles.js'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-browser-profiles-'))
})

afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

const mode = (path: string) => statSync(path).mode & 0o777

describe('BrowserProfileStore', () => {
	it('creates a descriptor and a 0700 user data directory', () => {
		const store = new BrowserProfileStore(home)
		const now = new Date('2026-09-23T10:00:00Z')
		const profile = store.ensureLocal('work', 'chromium', now)
		expect(profile).toEqual({
			v: 1,
			name: 'work',
			engine: 'local',
			userDataDir: join(home, 'browser', 'profiles', 'work'),
			browser: 'chromium',
			createdAt: '2026-09-23T10:00:00.000Z',
		})
		const onDisk = JSON.parse(readFileSync(join(home, 'browser', 'profiles', 'work.json'), 'utf8'))
		expect(onDisk).toEqual(profile)
		if (process.platform !== 'win32') {
			expect(mode(profile.userDataDir)).toBe(0o700)
			expect(mode(join(home, 'browser'))).toBe(0o700)
			expect(mode(join(home, 'browser', 'profiles', 'work.json'))).toBe(0o600)
		}
		expect(store.ensureLocal('work', 'chrome')).toEqual(profile)
	})

	it('lists, marks a sign-in, and removes', () => {
		const store = new BrowserProfileStore(home)
		store.ensureLocal('b', 'chromium')
		store.ensureLocal('a', 'chromium')
		expect(store.list().map((p) => p.name)).toEqual(['a', 'b'])
		const marked = store.markLogin('a', new Date('2026-09-23T11:00:00Z'))
		expect(marked.lastLoginAt).toBe('2026-09-23T11:00:00.000Z')
		expect(store.remove('a')).toBe(true)
		expect(store.get('a')).toBeUndefined()
		expect(store.remove('a')).toBe(false)
		expect(store.list().map((p) => p.name)).toEqual(['b'])
	})

	it('refuses names that could escape the directory', () => {
		const store = new BrowserProfileStore(home)
		for (const name of ['../x', 'Work', 'a--b', '', 'a/b', '-a', 'x'.repeat(65)]) {
			expect(() => store.ensureLocal(name, 'chromium')).toThrow(BrowserProfileError)
		}
	})

	it('refuses a profile another engine owns, and an unreadable descriptor', () => {
		const store = new BrowserProfileStore(home)
		store.ensureLocal('win', 'chromium')
		const path = join(home, 'browser', 'profiles', 'win.json')
		const descriptor = JSON.parse(readFileSync(path, 'utf8'))
		writeFileSync(path, JSON.stringify({ ...descriptor, engine: 'windows-cdp' }))
		expect(() => store.ensureLocal('win', 'chromium')).toThrow(/windows-cdp engine/)
		writeFileSync(path, '{')
		expect(() => store.get('win')).toThrow(/not JSON/)
		expect(store.list()).toEqual([])
	})

	it('records a Windows-engine profile by its Windows path, and removes it through the mount', () => {
		const store = new BrowserProfileStore(home)
		const mount = join(home, 'mnt')
		const windowsDir = 'C:\\Users\\Arda\\AppData\\Local\\namzu\\browser\\profiles\\work'
		const local = join(mount, 'c/Users/Arda/AppData/Local/namzu/browser/profiles/work')
		mkdirSync(join(local, 'Default'), { recursive: true })
		writeFileSync(join(local, 'DevToolsActivePort'), '9222\n/devtools/browser/x\n')
		const now = new Date('2026-09-23T12:00:00Z')
		const profile = store.ensureWindows('work', 'chrome', windowsDir, now)
		expect(profile).toEqual({
			v: 1,
			name: 'work',
			engine: 'windows-cdp',
			userDataDir: windowsDir,
			browser: 'chrome',
			createdAt: '2026-09-23T12:00:00.000Z',
		})
		// No directory of its own on this side.
		expect(existsSync(join(home, 'browser', 'profiles', 'work'))).toBe(false)
		expect(store.ensureWindows('work', 'chrome', windowsDir)).toEqual(profile)
		expect(() => store.ensureLocal('work', 'chromium')).toThrow(/windows-cdp engine/)
		expect(store.remove('work', undefined, { mountRoot: `${mount}/` })).toBe(true)
		expect(existsSync(local)).toBe(false)
		expect(store.get('work')).toBeUndefined()
	})

	it('removes a Windows-engine descriptor, never a directory that is not a namzu profile', () => {
		const store = new BrowserProfileStore(home)
		const mount = join(home, 'mnt')
		const precious = join(mount, 'c/Users/Arda/AppData/Local/Google/Chrome/User Data')
		mkdirSync(precious, { recursive: true })
		store.ensureWindows(
			'odd',
			'chrome',
			'C:\\Users\\Arda\\AppData\\Local\\Google\\Chrome\\User Data',
		)
		expect(store.remove('odd', undefined, { mountRoot: `${mount}/` })).toBe(true)
		expect(existsSync(precious)).toBe(true)
		expect(() => store.ensureWindows('odd', 'chrome', 'C:\\x')).not.toThrow()
		store.ensureLocal('loc', 'chromium')
		expect(() => store.ensureWindows('loc', 'chrome', 'C:\\x')).toThrow(/local engine/)
	})

	it('will not remove a profile a live process holds', () => {
		const store = new BrowserProfileStore(home)
		store.ensureLocal('busy', 'chromium')
		const lease = new BrowserLeaseStore(home).acquire('busy', 'tui')
		expect(() => store.remove('busy')).toThrow(ProfileBusyError)
		lease.release()
		expect(store.remove('busy')).toBe(true)
	})
})

describe('BrowserLeaseStore', () => {
	it('reports the last release', () => {
		const leases = new BrowserLeaseStore(home)
		const a = leases.acquire('work', 'one')
		const b = leases.acquire('work', 'two')
		expect(leases.holders('work')).toEqual([`${process.pid}-one`, `${process.pid}-two`])
		expect(a.release().last).toBe(false)
		expect(b.release().last).toBe(true)
		expect(b.release().last).toBe(true)
	})

	it('refuses an exclusive lease while another holder is live, and names it', () => {
		const alive = new Set([process.pid, 4242])
		const leases = new BrowserLeaseStore(home, (pid) => alive.has(pid))
		leases.acquire('work', 'sched', { pid: 4242 })
		let error: unknown
		try {
			leases.acquire('work', 'tui', { exclusive: true })
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(ProfileBusyError)
		expect((error as ProfileBusyError).holders).toEqual(['4242-sched'])
		// The refused lease left nothing behind.
		expect(leases.holders('work')).toEqual(['4242-sched'])
	})

	it('removes stale leases of dead processes', () => {
		const alive = new Set([process.pid])
		const leases = new BrowserLeaseStore(home, (pid) => alive.has(pid))
		leases.acquire('work', 'crashed', { pid: 999_999 })
		expect(leases.holders('work')).toEqual([])
		const lease = leases.acquire('work', 'tui', { exclusive: true })
		expect(lease.release().last).toBe(true)
	})

	it('refuses session ids that are not plain', () => {
		const leases = new BrowserLeaseStore(home)
		expect(() => leases.acquire('work', '../x')).toThrow(BrowserProfileError)
	})
})
