import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	CredentialStoreError,
	assertOwnerOnlyMode,
	assertSoleOwnerSddl,
	clearStoredSubscriptionCredential,
	credentialsPath,
	currentUserSid,
	readAclSddl,
	readStoredSubscriptionCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'

const SECRET = 'oat-secret-access-value'
const REFRESH = 'oat-secret-refresh-value'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-cred-'))
})
afterEach(() => {
	removeTempDir(home)
})

describe('round trip', () => {
	it('reads back exactly what was written', () => {
		const at = writeStoredSubscriptionCredential(
			{ accessToken: SECRET, refreshToken: REFRESH, expiresAt: 1234, scopes: ['a', 'b'] },
			home,
		)
		expect(at).toBe(credentialsPath(home))
		expect(readStoredSubscriptionCredential(home)).toEqual({
			accessToken: SECRET,
			refreshToken: REFRESH,
			expiresAt: 1234,
			scopes: ['a', 'b'],
		})
	})

	it('is absent, not thrown, when nothing was ever stored', () => {
		expect(readStoredSubscriptionCredential(home)).toBeNull()
	})

	it('is absent when the file is not JSON', () => {
		const path = credentialsPath(home)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, 'not json at all')
		expect(readStoredSubscriptionCredential(home)).toBeNull()
	})

	it('is absent when the envelope carries no access token', () => {
		const path = credentialsPath(home)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, JSON.stringify({ version: 1, subscription: { refreshToken: REFRESH } }))
		expect(readStoredSubscriptionCredential(home)).toBeNull()
	})

	it('clears, and clearing something absent is still success', () => {
		writeStoredSubscriptionCredential({ accessToken: SECRET }, home)
		clearStoredSubscriptionCredential(home)
		expect(existsSync(credentialsPath(home))).toBe(false)
		expect(() => clearStoredSubscriptionCredential(home)).not.toThrow()
	})

	it('overwrites a previous credential rather than accumulating', () => {
		writeStoredSubscriptionCredential({ accessToken: 'first' }, home)
		writeStoredSubscriptionCredential({ accessToken: 'second' }, home)
		expect(readStoredSubscriptionCredential(home)?.accessToken).toBe('second')
		const raw = readFileSync(credentialsPath(home), 'utf8')
		expect(raw).not.toContain('first')
	})

	it('leaves no temporary file behind', () => {
		writeStoredSubscriptionCredential({ accessToken: SECRET }, home)
		// A leftover temp file would be a SECOND copy of the credential, and the
		// one whose protection nothing re-checks after the rename.
		const entries = readdirSync(dirname(credentialsPath(home)))
		expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([])
	})
})

describe('the file is private, and the store proves it', () => {
	it.skipIf(platform() === 'win32')('has no group or other permission bits', () => {
		writeStoredSubscriptionCredential({ accessToken: SECRET }, home)
		const mode = statSync(credentialsPath(home)).mode
		expect(mode & 0o077).toBe(0)
	})

	it.skipIf(platform() !== 'win32')('grants exactly the current account, and nobody else', () => {
		writeStoredSubscriptionCredential({ accessToken: SECRET }, home)
		// Asserted from OUTSIDE the write, against the real list the filesystem
		// ended up with. Checking only that the write did not throw would leave
		// the whole protection step deletable without a single test noticing,
		// on the platform the step exists for.
		const sddl = readAclSddl(credentialsPath(home))
		const sid = currentUserSid()
		expect(sid).not.toBeNull()
		expect(sddl).not.toBeNull()
		expect(() => assertSoleOwnerSddl(sddl as string, sid as string, 'p')).not.toThrow()
		expect(readStoredSubscriptionCredential(home)?.accessToken).toBe(SECRET)
	})

	it.skipIf(platform() !== 'win32')('does not leave the directory it inherited from open', () => {
		writeStoredSubscriptionCredential({ accessToken: SECRET }, home)
		// `P` — the protected flag. Without it the file still takes whatever the
		// parent grants, which on a shared machine is the whole point missed.
		expect(readAclSddl(credentialsPath(home))).toMatch(/D:[A-Z]*P/)
	})
})

/**
 * The POSIX assertion, exercised on every platform.
 *
 * The branch that calls this only runs off Windows, so on Windows the check
 * is unreachable and a mutation deleting it kills nothing there. Testing the
 * comparison directly is what closes that: the rule is checked by whoever is
 * running the suite, whatever they are running it on.
 */
describe('assertOwnerOnlyMode', () => {
	it('accepts a file only its owner can read or write', () => {
		expect(() => assertOwnerOnlyMode(0o100600, 'p')).not.toThrow()
		expect(() => assertOwnerOnlyMode(0o100400, 'p')).not.toThrow()
	})

	it('refuses a bit granted to the group', () => {
		expect(() => assertOwnerOnlyMode(0o100640, 'p')).toThrow(CredentialStoreError)
	})

	it('refuses a bit granted to everyone else', () => {
		expect(() => assertOwnerOnlyMode(0o100604, 'p')).toThrow(CredentialStoreError)
		expect(() => assertOwnerOnlyMode(0o100666, 'p')).toThrow(CredentialStoreError)
	})

	it('refuses execute as readily as read, since either is access we did not grant', () => {
		expect(() => assertOwnerOnlyMode(0o100601, 'p')).toThrow(CredentialStoreError)
	})

	it('names the path and the mode, and nothing else', () => {
		expect(() => assertOwnerOnlyMode(0o100644, '/h/.namzu/credentials.json')).toThrow(
			/\/h\/\.namzu\/credentials\.json.*644/,
		)
	})
})

/**
 * The Windows assertion, exercised on every platform.
 *
 * `restrictToOwner` can only run where its tooling exists, and a security
 * check that is only ever executed on one operating system is a check most
 * contributors never see fail. The comparison itself is pure, so it is tested
 * everywhere — including the case that motivated writing it as a loop.
 */
describe('assertSoleOwnerSddl', () => {
	const US = 'S-1-5-21-1-2-3-1001'
	const THEM = 'S-1-1-0'

	it('accepts a protected list granting only us', () => {
		expect(() => assertSoleOwnerSddl(`D:PAI(A;;FA;;;${US})`, US, 'p')).not.toThrow()
	})

	it('accepts a differently-cased identifier', () => {
		expect(() => assertSoleOwnerSddl(`D:PAI(A;;FA;;;${US.toLowerCase()})`, US, 'p')).not.toThrow()
	})

	it('refuses a second allow entry naming somebody else', () => {
		// The case a check that stopped at the first match would call private.
		expect(() => assertSoleOwnerSddl(`D:PAI(A;;FA;;;${US})(A;;FA;;;${THEM})`, US, 'p')).toThrow(
			CredentialStoreError,
		)
	})

	it('refuses an allow entry naming somebody else FIRST', () => {
		expect(() => assertSoleOwnerSddl(`D:PAI(A;;FA;;;${THEM})(A;;FA;;;${US})`, US, 'p')).toThrow(
			CredentialStoreError,
		)
	})

	it('refuses a list that still inherits from its parent', () => {
		expect(() => assertSoleOwnerSddl(`D:AI(A;;FA;;;${US})`, US, 'p')).toThrow(CredentialStoreError)
	})

	it('refuses a list with no entries at all', () => {
		expect(() => assertSoleOwnerSddl('D:P', US, 'p')).toThrow(CredentialStoreError)
	})

	it('refuses a descriptor with no discretionary list', () => {
		expect(() => assertSoleOwnerSddl('O:BAG:BA', US, 'p')).toThrow(CredentialStoreError)
	})

	it('refuses a list that only denies, granting nobody', () => {
		expect(() => assertSoleOwnerSddl(`D:PAI(D;;FA;;;${THEM})`, US, 'p')).toThrow(
			CredentialStoreError,
		)
	})

	it('tolerates a deny entry naming somebody else beside our grant', () => {
		expect(() =>
			assertSoleOwnerSddl(`D:PAI(D;;FA;;;${THEM})(A;;FA;;;${US})`, US, 'p'),
		).not.toThrow()
	})

	it('never puts the path-holder secret in its message', () => {
		try {
			assertSoleOwnerSddl(`D:PAI(A;;FA;;;${THEM})`, US, '/home/x/.namzu/credentials.json')
			throw new Error('expected a refusal')
		} catch (err) {
			expect((err as Error).message).toContain('/home/x/.namzu/credentials.json')
			expect((err as Error).message).not.toContain(SECRET)
		}
	})
})
