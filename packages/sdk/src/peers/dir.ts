/**
 * The private per-user runtime directory peer sockets and the live-session
 * registry live in.
 *
 * Boundary = the OS user (design: cross-session messaging §1.1). Any process
 * of the same user can already read the user's files, so the directory only
 * has to keep OTHER users and the network out, and every candidate is
 * checked the same way: created 0700, refused if it turns out to be a
 * symlink, and — on POSIX — verified by `lstat` to really be owned by this
 * uid and to carry no group/other permission.
 *
 * The SDK cannot depend on the CLI's `ensurePrivateStateDirectory`
 * (`packages/cli/src/integrations/state/private-directory.ts`, which also
 * tightens a Windows ACL); {@link hardenPeerRuntimeDir} is the small subset
 * of that contract this module needs, reimplemented here so the dependency
 * direction (`sdk` never imports `cli`) holds. A caller with its own
 * directory-hardening policy may supply `hardenDirectory` instead.
 *
 * @experimental
 */

import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class PeerDirectoryError extends Error {
	override readonly name = 'PeerDirectoryError'
}

const PRIVATE_DIR_MODE = 0o700

/**
 * Session ids are UUIDv7 (`generateSessionId`, `utils/id.ts`): 36 characters.
 * `.sock` is the longest suffix {@link peerSocketFileName} ever appends, so
 * this is the longest socket filename the peers module creates — the figure
 * {@link resolvePeerRuntimeDir} subtracts from the platform's
 * `sockaddr_un.sun_path` limit before choosing a runtime directory.
 */
export const LONGEST_PEER_SOCKET_FILE_NAME_LENGTH = 36 + '.sock'.length

/** The socket filename for one session, placed directly inside the runtime directory. */
export function peerSocketFileName(sessionId: string): string {
	return `${sessionId}.sock`
}

const DARWIN_SUN_PATH_LIMIT = 104
/** Linux, and every other POSIX platform this runs on. */
const DEFAULT_SUN_PATH_LIMIT = 108

function platformSocketPathLimit(platform: NodeJS.Platform): number {
	return platform === 'darwin' ? DARWIN_SUN_PATH_LIMIT : DEFAULT_SUN_PATH_LIMIT
}

/**
 * Whether a socket file directly inside `dir` fits the platform's
 * `sockaddr_un.sun_path`. Windows named pipes live in a virtual namespace,
 * not the filesystem, so no directory ever fails this check there.
 */
function fitsSocketPath(dir: string, platform: NodeJS.Platform): boolean {
	if (platform === 'win32') return true
	// +1 for the path separator joining `dir` to the socket filename.
	return dir.length + 1 + LONGEST_PEER_SOCKET_FILE_NAME_LENGTH <= platformSocketPathLimit(platform)
}

/** Harden one directory in place; see {@link hardenPeerRuntimeDir}. Injectable for tests. */
export type HardenPeerDirectory = (path: string, uid: number | undefined) => void

/**
 * Create (or re-verify) a private directory for peer sockets and registry
 * records.
 *
 * Existing directories are tightened (`chmod`) on POSIX, then re-checked by
 * `lstat` — tightening a directory this uid does not own would fail, which is
 * exactly the outcome wanted, so the check afterward is the real gate. Skips
 * the POSIX-only steps on win32, where `chmod` only toggles the read-only
 * attribute and there is no uid to compare (`process.getuid` does not exist).
 */
export function hardenPeerRuntimeDir(path: string, uid: number | undefined): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
	const created = lstatSync(path)
	if (created.isSymbolicLink()) {
		throw new PeerDirectoryError(`Refusing peer runtime path ${path}: it is a symbolic link.`)
	}
	if (!created.isDirectory()) {
		throw new PeerDirectoryError(`Refusing peer runtime path ${path}: it is not a directory.`)
	}
	if (process.platform === 'win32') return
	chmodSync(path, PRIVATE_DIR_MODE)
	const entry = lstatSync(path)
	if (uid !== undefined && entry.uid !== uid) {
		throw new PeerDirectoryError(
			`Refusing peer runtime path ${path}: it belongs to uid ${entry.uid}, not ${uid}.`,
		)
	}
	if ((entry.mode & 0o777) !== PRIVATE_DIR_MODE) {
		throw new PeerDirectoryError(
			`Refusing peer runtime path ${path}: mode ${(entry.mode & 0o777).toString(8)} is not 0700.`,
		)
	}
}

export interface ResolvePeerRuntimeDirOptions {
	readonly env: NodeJS.ProcessEnv
	readonly namzuHome: string
	/** `undefined` models a platform with no uid (win32; `process.getuid` does not exist there). */
	readonly uid: number | undefined
	/** Default `process.platform`; override for tests. */
	readonly platform?: NodeJS.Platform
	/** Default `os.tmpdir()`; override for tests, matching `TempRootOptions.tmpdir` in `session/paths.ts`. */
	readonly tmpDir?: string
	/** Overrides {@link hardenPeerRuntimeDir}; primarily for tests that need to fabricate a failure. */
	readonly hardenDirectory?: HardenPeerDirectory
}

export interface PeerRuntimeDir {
	/** The directory sockets are created in. */
	readonly path: string
	/** `<path>/sessions`, holding one registry record per live session. */
	readonly sessionsDir: string
}

function peerRuntimeDirCandidates(options: ResolvePeerRuntimeDirOptions): readonly string[] {
	const candidates: string[] = []
	if (options.env.XDG_RUNTIME_DIR) candidates.push(join(options.env.XDG_RUNTIME_DIR, 'namzu'))
	candidates.push(join(options.namzuHome, 'run'))
	candidates.push(join(options.tmpDir ?? tmpdir(), `namzu-${options.uid ?? 'user'}`))
	return candidates
}

/**
 * Choose and harden the per-session peer runtime directory.
 *
 * Candidates, in order: `$XDG_RUNTIME_DIR/namzu`, `$NAMZU_HOME/run`,
 * `$TMPDIR/namzu-<uid>`. The first whose resulting socket paths fit this
 * platform's `sockaddr_un` limit is created 0700 (see
 * {@link hardenPeerRuntimeDir}), along with its `sessions/` subdirectory.
 */
export function resolvePeerRuntimeDir(options: ResolvePeerRuntimeDirOptions): PeerRuntimeDir {
	const platform = options.platform ?? process.platform
	const harden = options.hardenDirectory ?? hardenPeerRuntimeDir
	const candidates = peerRuntimeDirCandidates(options)
	const chosen = candidates.find((candidate) => fitsSocketPath(candidate, platform))
	if (!chosen) {
		throw new PeerDirectoryError(
			`No candidate peer runtime directory fits this platform's socket path limit (${platformSocketPathLimit(platform)} bytes): ${candidates.join(', ')}`,
		)
	}
	harden(chosen, options.uid)
	const sessionsDir = join(chosen, 'sessions')
	harden(sessionsDir, options.uid)
	return { path: chosen, sessionsDir }
}
