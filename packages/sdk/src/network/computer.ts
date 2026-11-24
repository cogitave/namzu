/**
 * The computer secret: how two Namzu homes of one person on one computer prove they share a computer.
 *
 * A "machine" on the Namzu network is a key, one per home, so the default home, a scheduler service home,
 * Desktop and a WSL terminal are each another machine. They may join without a person's Allow only when
 * the joiner shows it holds the same secret as the member it reached. That is the whole evidence: a source
 * address, a machine name, a hostname or a flag in the request prove nothing and are never consulted.
 *
 * One 32-byte secret per OS user lives at `<default home>/network/machine-secret` (mode 0600 in a 0700
 * directory). It is never sent: a proof is an HMAC over both ends of the TLS leg and the joiner's nonce.
 *
 * @experimental
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { hardenPeerRuntimeDir } from '../peers/dir.js'

export const COMPUTER_SECRET_FILE = 'machine-secret'
/** Beside the native secret on WSL: where the Windows profile's copy was found, so a service without interop finds it too. */
export const COMPUTER_SECRET_WINDOWS_PATH_FILE = 'machine-secret.windows-path'

const SECRET_BYTES = 32
const SECRET_HEX_LENGTH = SECRET_BYTES * 2
const KEY_DOMAIN = 'namzu-net/computer/key/1'
const JOIN_DOMAIN = 'namzu-net/computer/join/1'

/** How a secret file is trusted: by inspecting it (POSIX), or by where it lives (a Windows profile seen from WSL). */
export type ComputerSecretCheck = 'posix' | 'path-only'

export interface ComputerSecretSource {
	readonly path: string
	readonly check: ComputerSecretCheck
	/** True when this home may create the file when it is absent. */
	readonly create: boolean
}

export type ComputerSecretRead =
	| { readonly status: 'ok'; readonly secret: Buffer }
	| { readonly status: 'absent' }
	| { readonly status: 'unsafe'; readonly reason: string }

export interface ReadSecretOptions {
	readonly uid?: number | undefined
	/** Tests: pretend to be this platform. */
	readonly platform?: string
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined)

/**
 * Read the secret, refusing anything that could be someone else's or could have been read by someone else:
 * a symbolic link, a file that is not regular, one owned by another user, one readable or writable by
 * group or others, a directory others can write, or a file of the wrong size. A refusal is reported, never
 * repaired, and never replaced (a new secret would split the homes).
 */
export async function readComputerSecret(
	source: Pick<ComputerSecretSource, 'path' | 'check'>,
	options: ReadSecretOptions = {},
): Promise<ComputerSecretRead> {
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(source.path)
	} catch {
		return { status: 'absent' }
	}
	if (info.isSymbolicLink()) return { status: 'unsafe', reason: 'the secret is a symbolic link' }
	if (!info.isFile()) return { status: 'unsafe', reason: 'the secret is not a regular file' }
	const platform = options.platform ?? process.platform
	if (source.check === 'posix' && platform !== 'win32') {
		const uid = 'uid' in options ? options.uid : currentUid()
		if (uid !== undefined && info.uid !== uid)
			return { status: 'unsafe', reason: 'the secret belongs to another user' }
		if ((info.mode & 0o077) !== 0)
			return { status: 'unsafe', reason: 'the secret can be read by others (mode is not 0600)' }
		let parent: Awaited<ReturnType<typeof lstat>>
		try {
			parent = await lstat(dirname(source.path))
		} catch {
			return { status: 'unsafe', reason: 'the folder of the secret cannot be read' }
		}
		if (uid !== undefined && parent.uid !== uid)
			return { status: 'unsafe', reason: 'the folder of the secret belongs to another user' }
		if ((parent.mode & 0o022) !== 0)
			return { status: 'unsafe', reason: 'the folder of the secret can be written by others' }
	}
	let text: string
	try {
		text = (await readFile(source.path, 'utf8')).trim()
	} catch {
		return { status: 'unsafe', reason: 'the secret cannot be read' }
	}
	if (!/^[0-9a-f]+$/.test(text) || text.length !== SECRET_HEX_LENGTH)
		return { status: 'unsafe', reason: 'the secret is not the expected size' }
	return { status: 'ok', secret: Buffer.from(text, 'hex') }
}

/**
 * Create the secret when no file is there. Two homes starting together race: the file is written whole to a
 * private name and then linked into place, which fails for the loser, who reads the winner's. An existing
 * file (good or bad) is never overwritten.
 */
export async function ensureComputerSecret(
	source: ComputerSecretSource,
	harden: (dir: string) => void = (dir) => hardenPeerRuntimeDir(dir, currentUid()),
): Promise<'created' | 'exists'> {
	if (!source.create) return 'exists'
	try {
		await lstat(source.path)
		return 'exists'
	} catch {
		// absent: create below
	}
	const dir = dirname(source.path)
	harden(dir)
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const staging = join(
		dir,
		`.${COMPUTER_SECRET_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`,
	)
	const body = `${randomBytes(SECRET_BYTES).toString('hex')}\n`
	try {
		const handle = await open(staging, 'wx', 0o600)
		try {
			await handle.writeFile(body)
		} finally {
			await handle.close()
		}
		try {
			await link(staging, source.path)
			return 'created'
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
			// A filesystem without hard links: create exclusively instead.
			try {
				await writeFile(source.path, body, { flag: 'wx', mode: 0o600 })
				return 'created'
			} catch (inner) {
				if ((inner as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
				throw inner
			}
		}
	} finally {
		await unlink(staging).catch(() => undefined)
	}
}

const computerKey = (secret: Buffer): Buffer =>
	createHmac('sha256', secret).update(KEY_DOMAIN).digest()

/**
 * The proof a joiner attaches to its join request. It names both ends of the TLS leg as each side sees them
 * and the joiner's nonce, so a machine relaying between the two cannot reuse it and a copy of it from
 * another key does not verify.
 */
export function computerJoinProof(
	secret: Buffer,
	joinerMachineId: string,
	memberMachineId: string,
	joinerNonce: string,
): string {
	return createHmac('sha256', computerKey(secret))
		.update(JSON.stringify([JOIN_DOMAIN, joinerMachineId, memberMachineId, joinerNonce]), 'utf8')
		.digest('base64')
}

export function verifyComputerJoinProof(
	secret: Buffer,
	proof: string,
	joinerMachineId: string,
	memberMachineId: string,
	joinerNonce: string,
): boolean {
	const expected = Buffer.from(
		computerJoinProof(secret, joinerMachineId, memberMachineId, joinerNonce),
		'utf8',
	)
	const given = Buffer.from(proof, 'utf8')
	return given.length === expected.length && timingSafeEqual(given, expected)
}

// ─── which secret a home may use ─────────────────────────────────────────

export interface ResolveSecretDeps {
	readonly realpath: (path: string) => Promise<string>
	readonly exists: (path: string) => Promise<boolean>
	readonly readText: (path: string) => Promise<string | undefined>
	readonly writeText: (path: string, text: string) => Promise<void>
	/** Run a program and return its trimmed standard output, or undefined when it cannot run. */
	readonly exec: (command: string, args: readonly string[]) => Promise<string | undefined>
}

export interface ResolveSecretInput {
	/** This home (`NAMZU_HOME` or the default). */
	readonly home: string
	/** The OS user's home directory; the default Namzu home is `<osHome>/.namzu`. */
	readonly osHome: string
	readonly platform: string
	readonly env: NodeJS.ProcessEnv
	readonly deps: ResolveSecretDeps
}

/** Where a Windows profile seen from WSL may live: `/mnt/<drive>/Users/<name>`. Anything else is refused. */
const WINDOWS_PROFILE_FROM_WSL = /^\/mnt\/[a-z]\/Users\/[^/\0]+$/

export const windowsProfilePathOk = (path: string): boolean =>
	WINDOWS_PROFILE_FROM_WSL.test(path) && posix.normalize(path) === path

/** Whether `home` is the default home or a scheduler service home directly under it. */
export async function homeQualifies(
	home: string,
	osHome: string,
	realpath: (path: string) => Promise<string>,
): Promise<boolean> {
	const real = async (p: string) => realpath(p).catch(() => resolve(p))
	const defaultHome = await real(join(osHome, '.namzu'))
	const mine = await real(home)
	if (mine === defaultHome) return true
	const parent = dirname(mine)
	return basename(parent) === 'services' && dirname(parent) === defaultHome && mine !== parent
}

const isWsl = (platform: string, env: NodeJS.ProcessEnv) =>
	platform === 'linux' &&
	(typeof env.WSL_DISTRO_NAME === 'string' || typeof env.WSL_INTEROP === 'string')

/**
 * Which secret this home uses, or undefined when it uses none (it then asks a person like any other machine).
 *
 * Only the default home and a service home directly under it qualify; any other `NAMZU_HOME` (a scratch or
 * sandboxed home) never joins the person's network by itself. On Windows, Linux and macOS the native copy
 * is the secret. On WSL the Windows profile's copy is the source of truth when it can be read (so Desktop
 * and the WSL terminal agree), else the native WSL copy; Windows never reaches into WSL, whose distro may
 * not be running.
 */
export async function resolveComputerSecret(
	input: ResolveSecretInput,
): Promise<ComputerSecretSource | undefined> {
	const { home, osHome, platform, env, deps } = input
	if (!(await homeQualifies(home, osHome, deps.realpath))) return undefined
	const nativeDir = join(osHome, '.namzu', 'network')
	const native: ComputerSecretSource = {
		path: join(nativeDir, COMPUTER_SECRET_FILE),
		check: platform === 'win32' ? 'path-only' : 'posix',
		create: true,
	}
	if (!isWsl(platform, env)) return native

	const cachePath = join(nativeDir, COMPUTER_SECRET_WINDOWS_PATH_FILE)
	let profile: string | undefined
	const cached = (await deps.readText(cachePath))?.trim()
	if (cached !== undefined && windowsProfilePathOk(cached)) profile = cached
	if (profile === undefined && typeof env.WSL_INTEROP === 'string') {
		const raw = await deps.exec('cmd.exe', ['/c', 'echo %USERPROFILE%'])
		const win = raw?.replace(/\r/g, '').trim()
		if (win && !win.includes('%')) {
			const unix = (await deps.exec('wslpath', ['-u', win]))?.trim()
			if (unix !== undefined && windowsProfilePathOk(unix)) {
				profile = unix
				await deps.writeText(cachePath, `${unix}\n`).catch(() => undefined)
			}
		}
	}
	if (profile === undefined) return native
	const windowsPath = join(profile, '.namzu', 'network', COMPUTER_SECRET_FILE)
	// Only a copy Windows made: from here nothing is ever created in the Windows profile.
	if (!(await deps.exists(windowsPath))) return native
	return { path: windowsPath, check: 'path-only', create: false }
}
