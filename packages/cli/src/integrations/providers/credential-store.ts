/**
 * `~/.namzu/credentials.json` — the subscription credential namzu obtained itself.
 *
 * ## Why a file, said as a choice rather than a default
 *
 * The durable home a credential deserves is the operating system's own secret
 * store. namzu does not have one. The helper next door reads the macOS login
 * Keychain and belongs to a DIFFERENT product's entry — namzu borrows a token
 * from it — so writing namzu's own secret there would file our secret under
 * somebody else's name. On the platform this was asked for the store is not
 * that one at all, and no cross-platform binding exists in this package.
 *
 * So the options were: ship no durable credential, bind a native store per
 * platform, or own a file. This owns a file, and pays for it by making the
 * file's protection a CHECKED property rather than an assumption:
 *
 *  - it is created `0600` from birth (`wx` + mode, never a world-readable
 *    window), inside a `0700` directory;
 *  - after writing, the protection is READ BACK and asserted;
 *  - if the assertion cannot be made, the file is deleted and the write
 *    throws. A credential store that cannot prove it is private is a worse
 *    outcome than no credential store, and refusing is the rule this
 *    repository already holds (`docs/conventions/refuse-do-not-degrade.md`).
 *
 * The assertion is per-platform because the underlying protection is:
 *
 *  - POSIX: `chmod 0600`, then `stat` and require no group/other bits.
 *  - Windows: POSIX modes do not exist — `fs.chmod` there only toggles the
 *    read-only attribute, so a `0600` that "succeeded" would prove nothing.
 *    The equivalent is a discretionary ACL, so inheritance is removed and a
 *    single full-control entry is granted to the current user's SID; the ACL
 *    is then saved back as SDDL and required to contain exactly that one
 *    allow entry and nothing else.
 *
 * ## What is in the file
 *
 *   { "version": 1,
 *     "subscription": { "accessToken", "refreshToken", "expiresAt", "scopes" } }
 *
 * `subscription` is the credential a person's plan grants, obtained by the
 * login flow in `subscription-login.ts` and refreshed in place by `oauth.ts`.
 * Nothing else writes here.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AgentOAuthCredential } from './keychain.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export const CREDENTIALS_FILE_VERSION = 1 as const

/** Thrown when a credential could not be stored *privately*. Never carries a secret. */
export class CredentialStoreError extends Error {
	override readonly name = 'CredentialStoreError'
}

export type ConditionalCredentialWrite =
	| { readonly replaced: true; readonly current: AgentOAuthCredential }
	| { readonly replaced: false; readonly current: AgentOAuthCredential | null }

export function credentialsPath(home: string = homedir()): string {
	return join(home, '.namzu', 'credentials.json')
}

/**
 * The stored subscription credential, or `null` when there is none.
 *
 * Non-throwing on every shape of absence and corruption — a store that
 * refuses to parse is "no credential", which is what discovery can act on.
 * It does NOT swallow a permission error into `null` silently; that is still
 * absence from the reader's point of view, and the login path is what tells
 * the operator to try again.
 */
export function readStoredSubscriptionCredential(
	home: string = homedir(),
): AgentOAuthCredential | null {
	let raw: string
	try {
		raw = readFileSync(credentialsPath(home), 'utf8')
	} catch {
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const sub = (parsed as { subscription?: unknown }).subscription
	if (typeof sub !== 'object' || sub === null) return null
	const rec = sub as Record<string, unknown>
	const accessToken = rec.accessToken
	if (typeof accessToken !== 'string' || accessToken.length === 0) return null
	return {
		accessToken,
		refreshToken: typeof rec.refreshToken === 'string' ? rec.refreshToken : undefined,
		expiresAt: typeof rec.expiresAt === 'number' ? rec.expiresAt : undefined,
		scopes: Array.isArray(rec.scopes)
			? (rec.scopes.filter((s) => typeof s === 'string') as string[])
			: undefined,
	}
}

/**
 * Write the credential, privately, or throw having written nothing that lasts.
 *
 * Ordering matters and is the whole point: the temporary file is created with
 * the restrictive mode, secured, asserted, and only then renamed into place.
 * A file that appears at the final path and is tightened afterwards has a
 * window in which it is readable, and that window is the defect this ordering
 * removes.
 */
export function writeStoredSubscriptionCredential(
	cred: AgentOAuthCredential,
	home: string = homedir(),
): string {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () => writeStoredSubscriptionCredentialUnlocked(cred, path))
}

/**
 * Replace exactly the credential a refresh was derived from.
 *
 * Comparison and rename happen under the same store-owned cross-process lock.
 * A changed record is returned to the caller and is never overwritten. This is
 * the durable authority boundary a post-network plain reread cannot provide:
 * without the lock, another writer can still rotate the credential between
 * the comparison and the rename.
 */
export function replaceStoredSubscriptionCredential(
	expected: AgentOAuthCredential,
	replacement: AgentOAuthCredential,
	home: string = homedir(),
): ConditionalCredentialWrite {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	return withCredentialStoreLock(path, () => {
		const current = readStoredSubscriptionCredential(home)
		if (!sameCredential(current, expected)) return { replaced: false, current }
		writeStoredSubscriptionCredentialUnlocked(replacement, path)
		return { replaced: true, current: replacement }
	})
}

function writeStoredSubscriptionCredentialUnlocked(
	cred: AgentOAuthCredential,
	path: string,
): string {
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
	const body = `${JSON.stringify(
		{
			version: CREDENTIALS_FILE_VERSION,
			subscription: {
				accessToken: cred.accessToken,
				...(cred.refreshToken ? { refreshToken: cred.refreshToken } : {}),
				...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
				...(cred.scopes ? { scopes: cred.scopes } : {}),
			},
		},
		null,
		2,
	)}\n`

	let fd: number | undefined
	try {
		// `wx` — refuse an existing path rather than truncate one, so a name
		// collision can never hand us a file somebody else already opened.
		fd = openSync(tmp, 'wx', FILE_MODE)
		writeSync(fd, body)
	} catch (err) {
		if (fd !== undefined) closeSync(fd)
		rmSync(tmp, { force: true })
		throw new CredentialStoreError(
			`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	closeSync(fd)

	try {
		restrictToOwner(tmp)
	} catch (err) {
		rmSync(tmp, { force: true })
		throw err
	}

	try {
		renameSync(tmp, path)
	} catch (err) {
		rmSync(tmp, { force: true })
		throw new CredentialStoreError(
			`could not place ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	return path
}

/** Remove the stored credential. Absence is success. */
export function clearStoredSubscriptionCredential(home: string = homedir()): void {
	const path = credentialsPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	withCredentialStoreLock(path, () => rmSync(path, { force: true }))
}

function sameCredential(left: AgentOAuthCredential | null, right: AgentOAuthCredential): boolean {
	if (!left) return false
	if (
		left.accessToken !== right.accessToken ||
		left.refreshToken !== right.refreshToken ||
		left.expiresAt !== right.expiresAt
	) {
		return false
	}
	const leftScopes = left.scopes ?? []
	const rightScopes = right.scopes ?? []
	return (
		leftScopes.length === rightScopes.length &&
		leftScopes.every((scope, index) => scope === rightScopes[index])
	)
}

/**
 * Run one synchronous store mutation with cross-process exclusion.
 *
 * The lock is held only across local read/rename work, never across a network
 * request. A dead owner can leave a complete lock behind. It is deliberately
 * not stolen automatically: pathname-based stale reclamation cannot prove it
 * is unlinking the inode it inspected, so a delayed reclaimer can delete a new
 * owner's lock and admit two writers. A present lock is a refusal until an
 * operator proves no process owns the store and removes it.
 */
function withCredentialStoreLock<T>(path: string, operation: () => T): T {
	const lockPath = `${path}.lock`
	const token = `${process.pid}:${Date.now()}:${randomBytes(12).toString('hex')}`
	const published = publishLockAtomically(lockPath, token)
	if (!published.acquired) {
		throw new CredentialStoreError(
			`could not acquire the credential-store lock for ${path}: another owner or an unrecovered process lock is present (${published.error instanceof Error ? published.error.message : String(published.error)}). Refusing concurrent mutation; after proving no Namzu process is using this credential store, remove ${lockPath} and retry.`,
		)
	}

	try {
		return operation()
	} finally {
		// Do not remove a successor's lock if an external actor replaced the file.
		try {
			if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true })
		} catch {
			// The mutation already has its result. A missing/replaced lock is not
			// evidence that the credential itself failed to publish.
		}
	}
}

/**
 * Publish a complete owner record at the canonical name in one filesystem op.
 *
 * Creating the canonical file and then writing its token has a fatal crash
 * window: an empty lock names no owner and can never be reclaimed safely. The
 * candidate is completed and synced first; `linkSync` is the exclusive claim.
 * A pre-link crash can leave candidate debris, but it never blocks the store.
 */
function publishLockAtomically(
	lockPath: string,
	token: string,
): { readonly acquired: true } | { readonly acquired: false; readonly error: unknown } {
	const candidatePath = `${lockPath}.candidate.${process.pid}.${randomBytes(12).toString('hex')}`
	let fd: number | undefined
	try {
		fd = openSync(candidatePath, 'wx', FILE_MODE)
		writeFileSync(fd, token, 'utf8')
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
	} catch (error) {
		if (fd !== undefined) closeSync(fd)
		rmSync(candidatePath, { force: true })
		throw new CredentialStoreError(
			`could not prepare the credential-store lock: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	try {
		linkSync(candidatePath, lockPath)
		return { acquired: true }
	} catch (error) {
		return { acquired: false, error }
	} finally {
		try {
			rmSync(candidatePath, { force: true })
		} catch {
			// Candidate debris is non-canonical and cannot block another owner.
			// Once the hard link succeeds, cleanup must not erase that acquisition
			// result and skip the token-checked canonical release path.
		}
	}
}
/**
 * Make `path` readable and writable by its owner and by nobody else, and
 * PROVE it. Throws `CredentialStoreError` when the proof cannot be produced.
 *
 * Exported because it is the load-bearing half of this module and a security
 * property nobody can check by reading the caller.
 */
export function restrictToOwner(path: string): void {
	if (platform() === 'win32') {
		restrictToOwnerWindows(path)
		return
	}
	// POSIX. `openSync` already asked for the mode; a umask cannot loosen it,
	// but an inherited ACL or an exotic filesystem can, so this reads it back
	// instead of trusting the request.
	let mode: number
	try {
		mode = statSync(path).mode
	} catch (err) {
		throw new CredentialStoreError(
			`could not read back the permissions of ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	assertOwnerOnlyMode(mode, path)
}

/**
 * Require a POSIX mode to grant nothing to group or other.
 *
 * Split out for the same reason `assertSoleOwnerSddl` is: it is the actual
 * assertion, and one that only ever executes on some platforms is one most
 * contributors never see fail. As a pure function it is checked everywhere,
 * including by whoever is on the operating system where the branch that calls
 * it is unreachable.
 */
export function assertOwnerOnlyMode(mode: number, path: string): void {
	if ((mode & 0o077) !== 0) {
		throw new CredentialStoreError(
			`${path} is readable beyond its owner (mode ${(mode & 0o777).toString(8)}) and the filesystem would not tighten it — refusing to keep a credential there.`,
		)
	}
}

/**
 * The Windows half: remove inheritance, grant the current user's SID full
 * control, then read the resulting ACL back as SDDL and require it to be
 * exactly that one allow entry.
 *
 * Both helpers are invoked by absolute path under `%SystemRoot%\System32`.
 * Resolving them through `PATH` is how a same-named executable earlier on the
 * path gets to answer a security question on our behalf, and on a developer
 * machine `PATH` routinely carries a POSIX toolchain that shadows these names.
 */
function restrictToOwnerWindows(path: string): void {
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	const run = (exe: string, args: readonly string[]): string => {
		try {
			return execFileSync(join(system32, exe), [...args], {
				encoding: 'utf8',
				timeout: 10_000,
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			})
		} catch (err) {
			throw new CredentialStoreError(
				`${exe} could not secure ${path} (${err instanceof Error ? err.message : String(err)}). namzu will not keep a credential in a file it cannot prove is private.`,
			)
		}
	}

	// `whoami /user /fo csv /nh` prints  "DOMAIN\user","S-1-5-21-…"
	const sid = currentUserSid()
	if (!sid) {
		throw new CredentialStoreError(
			`could not determine the current account's security identifier, so the protection of ${path} cannot be established.`,
		)
	}

	run('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:F`])

	const saved = readAclSddl(path)
	if (saved === null) {
		throw new CredentialStoreError(
			`could not read back the access-control list of ${path}, so its privacy is unestablished.`,
		)
	}
	assertSoleOwnerSddl(saved, sid, path)
}

/**
 * The file's discretionary access-control list, as SDDL, or `null`.
 *
 * `null` off Windows and on any failure to read. Exported so a test can make
 * the Windows arm a real assertion instead of "the write did not throw" —
 * without it, deleting the entire protection step would kill no test on the
 * platform the protection is FOR, and the only coverage would be the POSIX
 * branch running somewhere else.
 *
 * `icacls /save` writes a UTF-16 file whose second line is the descriptor.
 * SDDL names principals by security identifier, so nothing here depends on
 * the machine's display language.
 */
export function readAclSddl(path: string): string | null {
	if (platform() !== 'win32') return null
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	const aclPath = join(tmpdir(), `namzu-acl-${randomBytes(6).toString('hex')}`)
	try {
		execFileSync(join(system32, 'icacls.exe'), [path, '/save', aclPath], {
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
		})
		return readFileSync(aclPath, 'utf16le')
	} catch {
		return null
	} finally {
		rmSync(aclPath, { force: true })
	}
}

/** The current account's security identifier, or `null` off Windows / on failure. */
export function currentUserSid(): string | null {
	if (platform() !== 'win32') return null
	const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
	try {
		const out = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
		})
		return out.match(/"(S-1-[0-9-]+)"/)?.[1] ?? null
	} catch {
		return null
	}
}

/**
 * Require an SDDL discretionary ACL to grant exactly one principal, and that
 * principal to be `sid`.
 *
 * Split out from the spawning above because it is the actual assertion, and
 * an assertion that can only run on one operating system is an assertion
 * nobody checks. Every entry is examined, not just the first: an ACL reading
 * `(A;;FA;;;US)(A;;FA;;;WD)` grants us AND everyone, and a check that stopped
 * at a match would call that private.
 */
export function assertSoleOwnerSddl(sddl: string, sid: string, path: string): void {
	const dacl = sddl.match(/D:([A-Z]*)((?:\([^)]*\))*)/)
	const flags = dacl?.[1] ?? ''
	const body = dacl?.[2] ?? ''
	if (!dacl || body.length === 0) {
		throw new CredentialStoreError(
			`the access-control list of ${path} could not be read back, so its privacy is unestablished.`,
		)
	}
	if (!flags.includes('P')) {
		throw new CredentialStoreError(
			`${path} still inherits permissions from its parent folder, so accounts other than yours may read it.`,
		)
	}
	const aces = [...body.matchAll(/\(([^)]*)\)/g)].map((m) => (m[1] ?? '').split(';'))
	if (aces.length === 0) {
		throw new CredentialStoreError(
			`the access-control list of ${path} could not be read back, so its privacy is unestablished.`,
		)
	}
	for (const ace of aces) {
		const type = ace[0] ?? ''
		const trustee = ace[5] ?? ''
		// Only an ALLOW entry grants anything; a DENY entry narrows and is safe.
		if (type !== 'A' && type !== 'AI') continue
		if (trustee.toUpperCase() !== sid.toUpperCase()) {
			throw new CredentialStoreError(
				`${path} grants access to an account other than yours (${trustee}) — refusing to keep a credential there.`,
			)
		}
	}
	if (!aces.some((ace) => (ace[0] ?? '') === 'A' || (ace[0] ?? '') === 'AI')) {
		throw new CredentialStoreError(
			`${path} ended with no account able to read it, which is not a credential store — refusing.`,
		)
	}
}
