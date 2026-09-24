import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	LONGEST_PEER_SOCKET_FILE_NAME_LENGTH,
	PeerDirectoryError,
	hardenPeerRuntimeDir,
	peerSocketFileName,
	resolvePeerRuntimeDir,
} from './dir.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function makeTempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-peers-dir-test-'))
	dirs.push(dir)
	return dir
}

const uid = process.getuid?.()

describe('resolvePeerRuntimeDir', () => {
	it('prefers $XDG_RUNTIME_DIR/namzu when set, hardened 0700 with a sessions/ subdir', () => {
		const root = makeTempRoot()
		const result = resolvePeerRuntimeDir({
			env: { XDG_RUNTIME_DIR: root },
			namzuHome: join(root, 'home'),
			uid,
			platform: 'linux',
		})
		expect(result.path).toBe(join(root, 'namzu'))
		expect(result.sessionsDir).toBe(join(root, 'namzu', 'sessions'))
		expect(lstatSync(result.path).mode & 0o777).toBe(0o700)
		expect(lstatSync(result.sessionsDir).mode & 0o777).toBe(0o700)
	})

	it('falls back to $NAMZU_HOME/run when XDG_RUNTIME_DIR is unset', () => {
		const root = makeTempRoot()
		const result = resolvePeerRuntimeDir({ env: {}, namzuHome: root, uid, platform: 'linux' })
		expect(result.path).toBe(join(root, 'run'))
	})

	it('ignores an empty XDG_RUNTIME_DIR', () => {
		const root = makeTempRoot()
		const result = resolvePeerRuntimeDir({
			env: { XDG_RUNTIME_DIR: '' },
			namzuHome: root,
			uid,
			platform: 'linux',
		})
		expect(result.path).toBe(join(root, 'run'))
	})

	it('falls back to the tmp root when the preferred path is too long for this platform', () => {
		const root = makeTempRoot()
		const longNamzuHome = join(root, 'x'.repeat(200))
		const result = resolvePeerRuntimeDir({
			env: {},
			namzuHome: longNamzuHome,
			uid,
			platform: 'linux',
			tmpDir: root,
		})
		expect(result.path).not.toBe(join(longNamzuHome, 'run'))
		expect(result.path).toBe(join(root, `namzu-${uid ?? 'user'}`))
	})

	it('the longest socket filename is a 36-character UUIDv7 session id plus .sock', () => {
		expect(LONGEST_PEER_SOCKET_FILE_NAME_LENGTH).toBe(41)
	})

	it('never checks the socket-path budget on win32, where sockets are named pipes', () => {
		const root = makeTempRoot()
		const longNamzuHome = join(root, 'x'.repeat(200))
		const result = resolvePeerRuntimeDir({
			env: {},
			namzuHome: longNamzuHome,
			uid: undefined,
			platform: 'win32',
			hardenDirectory: () => {},
		})
		expect(result.path).toBe(join(longNamzuHome, 'run'))
	})

	it('accepts an injected hardening function instead of touching the filesystem', () => {
		const root = makeTempRoot()
		const calls: string[] = []
		resolvePeerRuntimeDir({
			env: { XDG_RUNTIME_DIR: root },
			namzuHome: join(root, 'home'),
			uid,
			platform: 'linux',
			hardenDirectory: (path) => {
				calls.push(path)
			},
		})
		expect(calls).toEqual([join(root, 'namzu'), join(root, 'namzu', 'sessions')])
		expect(existsSync(join(root, 'namzu'))).toBe(false)
	})

	it('falls back to the next length-fitting candidate when hardening the preferred one fails for a reason other than length', () => {
		// Models a hostile or merely misconfigured $XDG_RUNTIME_DIR: a real
		// hardenPeerRuntimeDir would throw EPERM from chmod() on a directory
		// this process does not own. The call must not fail outright — it
		// should fall through to $NAMZU_HOME/run, which is perfectly usable.
		const root = makeTempRoot()
		const attempted: string[] = []
		const result = resolvePeerRuntimeDir({
			env: { XDG_RUNTIME_DIR: join(root, 'hostile') },
			namzuHome: join(root, 'home'),
			uid,
			platform: 'linux',
			hardenDirectory: (path) => {
				attempted.push(path)
				if (path.startsWith(join(root, 'hostile'))) {
					throw new Error('EPERM: chmod not permitted (directory owned by another uid)')
				}
			},
		})
		expect(result.path).toBe(join(root, 'home', 'run'))
		expect(result.sessionsDir).toBe(join(root, 'home', 'run', 'sessions'))
		expect(attempted).toEqual([
			join(root, 'hostile', 'namzu'),
			join(root, 'home', 'run'),
			join(root, 'home', 'run', 'sessions'),
		])
	})

	it('throws naming every length-fitting candidate and why when none of them can be hardened', () => {
		const root = makeTempRoot()
		const xdg = join(root, 'xdg')
		const home = join(root, 'home')
		const tmp = join(root, 'tmp')
		let thrown: unknown
		try {
			resolvePeerRuntimeDir({
				env: { XDG_RUNTIME_DIR: xdg },
				namzuHome: home,
				uid,
				platform: 'linux',
				tmpDir: tmp,
				hardenDirectory: (path) => {
					throw new Error(`unusable: ${path}`)
				},
			})
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(PeerDirectoryError)
		const message = (thrown as Error).message
		expect(message).toContain(join(xdg, 'namzu'))
		expect(message).toContain(join(home, 'run'))
	})

	it('never attempts a candidate that does not fit the length budget, even when every fitting one fails', () => {
		const root = makeTempRoot()
		const longNamzuHome = join(root, 'x'.repeat(200))
		const attempted: string[] = []
		expect(() =>
			resolvePeerRuntimeDir({
				env: {},
				namzuHome: longNamzuHome,
				uid,
				platform: 'linux',
				tmpDir: root,
				hardenDirectory: (path) => {
					attempted.push(path)
					throw new Error('nope')
				},
			}),
		).toThrow(PeerDirectoryError)
		// Only the tmp fallback fits; $NAMZU_HOME/run never does, so it is
		// never even offered to hardenDirectory.
		expect(attempted).toEqual([join(root, `namzu-${uid ?? 'user'}`)])
	})

	it('throws when not even the tmp fallback fits the platform limit', () => {
		const hugeTmp = `/${'t'.repeat(200)}`
		expect(() =>
			resolvePeerRuntimeDir({
				env: {},
				namzuHome: `/${'h'.repeat(200)}`,
				uid,
				platform: 'linux',
				tmpDir: hugeTmp,
				hardenDirectory: () => {
					throw new Error('unreachable: no candidate should have been chosen')
				},
			}),
		).toThrow(PeerDirectoryError)
	})
})

describe('hardenPeerRuntimeDir', () => {
	it('refuses a symlink standing in for the runtime directory', () => {
		const root = makeTempRoot()
		const real = join(root, 'elsewhere')
		mkdirSync(real)
		const linkPath = join(root, 'namzu')
		symlinkSync(real, linkPath)
		expect(() => hardenPeerRuntimeDir(linkPath, uid)).toThrow(PeerDirectoryError)
	})

	it('refuses a directory owned by a different uid', () => {
		if (uid === undefined) return // win32 models no uid to mismatch.
		const root = makeTempRoot()
		const path = join(root, 'namzu')
		expect(() => hardenPeerRuntimeDir(path, uid + 999_999)).toThrow(PeerDirectoryError)
	})

	it('is idempotent: hardening an already-hardened directory again succeeds', () => {
		const root = makeTempRoot()
		const path = join(root, 'namzu')
		hardenPeerRuntimeDir(path, uid)
		expect(() => hardenPeerRuntimeDir(path, uid)).not.toThrow()
		expect(lstatSync(path).mode & 0o777).toBe(0o700)
	})

	it('tightens an existing directory that was created too open', () => {
		const root = makeTempRoot()
		const path = join(root, 'namzu')
		mkdirSync(path, { mode: 0o755 })
		hardenPeerRuntimeDir(path, uid)
		expect(lstatSync(path).mode & 0o777).toBe(0o700)
	})
})

describe('peerSocketFileName', () => {
	it('appends .sock to the session id', () => {
		expect(peerSocketFileName('abc-123')).toBe('abc-123.sock')
	})
})
