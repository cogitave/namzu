import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	CredentialStoreError,
	clearStoredSubscriptionCredential,
	credentialsPath,
	locateStoredCodexCredential,
	locateStoredSubscriptionCredential,
	readStoredCodexCredential,
	readStoredSubscriptionCredential,
	replaceStoredCodexCredential,
	replaceStoredSubscriptionCredential,
	writeStoredCodexCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'
import {
	configureDesktopSignInSharing,
	desktopCredentialsPath,
	setWindowsHomeLocator,
} from './desktop-sign-in.js'

const desktop = { accessToken: 'desktop-access-1', refreshToken: 'desktop-refresh-1', expiresAt: 1 }
const own = { accessToken: 'own-access-1', refreshToken: 'own-refresh-1', expiresAt: 2 }

let root: string
let wslHome: string
let windowsHome: string

/** A fake mounted Windows home under the test's temp dir; the real drive is never touched. */
function desktopStorePath(): string {
	return join(windowsHome, '.namzu', 'credentials.json')
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-sign-in-'))
	wslHome = join(root, 'wsl-home')
	windowsHome = join(root, 'mnt-c-users-person')
	mkdirSync(wslHome, { recursive: true })
	mkdirSync(windowsHome, { recursive: true })
	vi.stubEnv('HOME', wslHome)
	vi.stubEnv('USERPROFILE', wslHome)
	vi.stubEnv('NAMZU_HOME', '')
	vi.stubEnv('NAMZU_SHARE_DESKTOP_SIGNIN', '')
	configureDesktopSignInSharing(undefined)
	setWindowsHomeLocator(() => windowsHome)
})
afterEach(() => {
	setWindowsHomeLocator(undefined)
	configureDesktopSignInSharing(undefined)
	vi.unstubAllEnvs()
	removeTempDir(root)
})

describe('reading a Desktop sign-in from the terminal', () => {
	it('uses the Windows store when the terminal has no sign-in of its own, and says where from', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		expect(readStoredSubscriptionCredential()).toEqual(desktop)
		expect(locateStoredSubscriptionCredential()).toEqual({
			path: desktopStorePath(),
			shared: 'desktop',
		})
	})

	it('prefers the terminal’s own sign-in, so two different accounts are never mixed', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		writeStoredSubscriptionCredential(own, wslHome)
		expect(readStoredSubscriptionCredential()).toEqual(own)
		expect(locateStoredSubscriptionCredential()).toEqual({
			path: credentialsPath(),
			shared: null,
		})
	})

	it('is per provider: a Codex sign-in on Windows is used while Claude stays the terminal’s own', () => {
		writeStoredSubscriptionCredential(own, wslHome)
		writeStoredCodexCredential({ ...desktop, accountId: 'acct-1' }, windowsHome)
		expect(readStoredSubscriptionCredential()).toEqual(own)
		expect(readStoredCodexCredential()?.accountId).toBe('acct-1')
		expect(locateStoredCodexCredential()?.shared).toBe('desktop')
	})

	it('does nothing for an explicit home or NAMZU_HOME', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		expect(readStoredSubscriptionCredential(join(root, 'elsewhere'))).toBeNull()
		const namzuHome = join(root, 'chosen')
		mkdirSync(namzuHome)
		vi.stubEnv('NAMZU_HOME', namzuHome)
		expect(readStoredSubscriptionCredential()).toBeNull()
		expect(desktopCredentialsPath()).toBeNull()
	})

	it('is turned off by the setting and by the environment variable', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		configureDesktopSignInSharing(false)
		expect(readStoredSubscriptionCredential()).toBeNull()
		configureDesktopSignInSharing(undefined)
		expect(readStoredSubscriptionCredential()).toEqual(desktop)
		vi.stubEnv('NAMZU_SHARE_DESKTOP_SIGNIN', '0')
		expect(readStoredSubscriptionCredential()).toBeNull()
		// The variable wins over the setting in both directions.
		vi.stubEnv('NAMZU_SHARE_DESKTOP_SIGNIN', '1')
		configureDesktopSignInSharing(false)
		expect(readStoredSubscriptionCredential()).toEqual(desktop)
	})

	it('treats an unresolvable Windows home, a missing file, a corrupt file and a link as no sign-in', () => {
		setWindowsHomeLocator(() => null)
		expect(readStoredSubscriptionCredential()).toBeNull()
		setWindowsHomeLocator(() => windowsHome)
		expect(readStoredSubscriptionCredential()).toBeNull()

		mkdirSync(join(windowsHome, '.namzu'), { recursive: true })
		writeStoredSubscriptionCredential(desktop, windowsHome)
		const real = desktopStorePath()
		const moved = join(root, 'moved.json')
		renameSync(real, moved)
		try {
			symlinkSync(moved, real)
		} catch {
			return // a platform without symlinks has nothing to refuse
		}
		expect(readStoredSubscriptionCredential()).toBeNull()
	})

	it('reads a sign-in that cannot be parsed as none', () => {
		mkdirSync(join(windowsHome, '.namzu'), { recursive: true })
		writeFileSync(desktopStorePath(), '{ not json')
		expect(readStoredSubscriptionCredential()).toBeNull()
	})

	it('does not ask for the Windows home when the terminal already has its own sign-in', () => {
		const locator = vi.fn(() => windowsHome)
		setWindowsHomeLocator(locator)
		writeStoredSubscriptionCredential(own, wslHome)
		readStoredSubscriptionCredential()
		expect(locator).not.toHaveBeenCalled()
	})
})

describe('refreshing a shared sign-in', () => {
	const rotated = {
		accessToken: 'desktop-access-2',
		refreshToken: 'desktop-refresh-2',
		expiresAt: 9,
	}

	it('writes the rotation back to the Windows file, the one source of truth, and creates no copy', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		const result = replaceStoredSubscriptionCredential(desktop, rotated)
		expect(result).toEqual({ replaced: true, current: rotated })
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(rotated)
		expect(existsSync(credentialsPath())).toBe(false)
		// Nothing is left behind in the Windows directory: no lock, no temp file.
		expect(readdirSync(join(windowsHome, '.namzu'))).toEqual(['credentials.json'])
	})

	it('writes the Codex rotation back the same way', () => {
		const codex = { ...desktop, accountId: 'acct-1' }
		writeStoredCodexCredential(codex, windowsHome)
		const next = { ...codex, accessToken: 'codex-access-2', refreshToken: 'codex-refresh-2' }
		expect(replaceStoredCodexCredential(codex, next).replaced).toBe(true)
		expect(readStoredCodexCredential(windowsHome)).toEqual(next)
		expect(existsSync(credentialsPath())).toBe(false)
	})

	it('hands back a rotation the Desktop made meanwhile instead of overwriting it', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		writeStoredSubscriptionCredential(rotated, windowsHome)
		const stale = { accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresAt: 5 }
		const result = replaceStoredSubscriptionCredential(desktop, stale)
		expect(result).toEqual({ replaced: false, current: rotated })
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(rotated)
	})

	it('refuses while the Windows side holds the lock, and says so in terms of Desktop', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		writeFileSync(`${desktopStorePath()}.lock`, 'windows-owner')
		let failure: unknown
		try {
			replaceStoredSubscriptionCredential(desktop, rotated)
		} catch (error) {
			failure = error
		}
		expect(failure).toBeInstanceOf(CredentialStoreError)
		expect((failure as Error).message).toMatch(/Namzu Desktop on Windows/)
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(desktop)
	})

	it('keeps a sign-in made on the terminal separate: its own file is the one refreshed', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		writeStoredSubscriptionCredential(own, wslHome)
		const next = { ...own, accessToken: 'own-access-2' }
		expect(replaceStoredSubscriptionCredential(own, next).replaced).toBe(true)
		expect(readStoredSubscriptionCredential(wslHome)).toEqual(next)
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(desktop)
	})

	it('a session that began on the shared sign-in keeps refreshing that file after the terminal signs in', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		writeStoredSubscriptionCredential(own, wslHome)
		expect(replaceStoredSubscriptionCredential(desktop, rotated).replaced).toBe(true)
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(rotated)
		expect(readStoredSubscriptionCredential(wslHome)).toEqual(own)
	})
})

describe('signing out', () => {
	it('on the terminal never removes the Desktop’s sign-in', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		clearStoredSubscriptionCredential()
		expect(readStoredSubscriptionCredential(windowsHome)).toEqual(desktop)
		expect(readStoredSubscriptionCredential()).toEqual(desktop)
		expect(readFileSync(desktopStorePath(), 'utf8')).toContain('desktop-access-1')
	})

	it('on Windows (the file is gone) the terminal sees no sign-in', () => {
		writeStoredSubscriptionCredential(desktop, windowsHome)
		clearStoredSubscriptionCredential(windowsHome)
		expect(readStoredSubscriptionCredential()).toBeNull()
	})
})

describe('discovery', () => {
	it('reports the Desktop store as the source, marked shared', async () => {
		const { discoverProviders, findDetected } = await import('./discover.js')
		const { describeAccess } = await import('./setup.js')
		writeStoredSubscriptionCredential(
			{ accessToken: 'desktop-access-1', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
			windowsHome,
		)
		const found = await discoverProviders({
			env: {},
			skipKeychain: true,
			skipProbes: true,
			windowsHome: null,
		})
		const anthropic = findDetected(found, 'anthropic')
		expect(anthropic?.source).toEqual({
			kind: 'stored',
			path: desktopStorePath(),
			shared: 'desktop',
		})
		expect(anthropic?.oauth?.origin).toBe('stored')
		expect(describeAccess(anthropic?.source as never)).toBe(
			'Signed in with Namzu Desktop on Windows',
		)
	})
})
