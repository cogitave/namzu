import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractZipEntry } from './zip.js'

/**
 * The cua-driver build this package drives on Windows, pinned by version and
 * by SHA-256 of both the release archive and the executable inside it.
 *
 * cua-driver (github.com/trycua/cua, MIT) publishes every build as a GitHub
 * prerelease with a `checksums.txt`; the archive hashes below are the ones it
 * lists for `cua-driver-rs-v0.28.2`, and the executable hashes were taken
 * from those archives. Moving to another build means changing all four and
 * re-running the Windows verification in `docs/sdk/computer-actions.md`.
 */
export const CUA_DRIVER_RELEASE = {
	version: '0.28.2',
	tag: 'cua-driver-rs-v0.28.2',
	baseUrl: 'https://github.com/trycua/cua/releases/download',
	windows: {
		x64: {
			archive: 'cua-driver-rs-0.28.2-windows-x86_64-binary.zip',
			archiveSize: 29_085_823,
			archiveSha256: '1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba',
			exeSize: 30_922_064,
			exeSha256: 'dbbd52d75759900155fbf3d5f0a13c759a12d06ef17338b88b3f2b8b9c1ef8dc',
		},
		arm64: {
			archive: 'cua-driver-rs-0.28.2-windows-arm64-binary.zip',
			archiveSize: 27_394_922,
			archiveSha256: '578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680',
			exeSize: 26_643_272,
			exeSha256: '8f36d502e841485c59fd6734e2193841c61f234870f8b92c3d7d0c18123b28ba',
		},
	},
} as const

export type CuaDriverArch = keyof typeof CUA_DRIVER_RELEASE.windows

/** One pinned archive and the executable inside it. */
export interface CuaDriverAssetPin {
	readonly archive: string
	readonly archiveSize: number
	readonly archiveSha256: string
	readonly exeSize: number
	readonly exeSha256: string
}

const EXE_NAME = 'cua-driver.exe'

export interface ResolveCuaDriverOptions {
	/** An existing `cua-driver.exe` to use as it is: no download, no hash check. */
	readonly path?: string
	/** Where the pinned build is kept. Default `<NAMZU_HOME>/computer-use/cua-driver/<version>`. */
	readonly cacheDir?: string
	/** Download the pinned build when it is not cached. Default true. */
	readonly download?: boolean
	/** Default `process.arch`. Windows under WSL has the distro's architecture. */
	readonly arch?: string
	readonly env?: NodeJS.ProcessEnv
	/** How long the archive download may take. Default 180 s. */
	readonly downloadTimeoutMs?: number
	/** For tests. */
	readonly fetch?: typeof fetch
	/** For tests: another pin than the architecture's. */
	readonly asset?: CuaDriverAssetPin
}

export interface ResolvedCuaDriver {
	readonly path: string
	/** Where it came from: the caller, the cache, or a download just now. */
	readonly source: 'configured' | 'cache' | 'download'
}

export class CuaDriverUnavailableError extends Error {
	override readonly name = 'CuaDriverUnavailableError'
}

/** `<NAMZU_HOME>/computer-use/cua-driver/<version>`, `NAMZU_HOME` defaulting to `~/.namzu`. */
export function defaultCuaDriverCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const home =
		env.NAMZU_HOME && env.NAMZU_HOME.length > 0 ? env.NAMZU_HOME : join(homedir(), '.namzu')
	return join(home, 'computer-use', 'cua-driver', CUA_DRIVER_RELEASE.version)
}

/** The pinned asset for an architecture, or undefined when cua-driver ships none. */
export function cuaDriverAsset(arch: string): CuaDriverAssetPin | undefined {
	if (arch === 'x64' || arch === 'arm64') return CUA_DRIVER_RELEASE.windows[arch]
	return undefined
}

export function cuaDriverDownloadUrl(archive: string): string {
	return `${CUA_DRIVER_RELEASE.baseUrl}/${CUA_DRIVER_RELEASE.tag}/${archive}`
}

/** Executables already hashed by this process, keyed by path, with the size and mtime seen. */
const verified = new Map<string, string>()

/**
 * The `cua-driver.exe` to run: the caller's, else the pinned build from the
 * cache (hash-checked once per process), else — when allowed — the pinned
 * archive downloaded, checked, and unpacked into the cache. Throws
 * {@link CuaDriverUnavailableError} with the reason otherwise.
 */
export async function resolveCuaDriver(
	options: ResolveCuaDriverOptions = {},
): Promise<ResolvedCuaDriver> {
	if (options.path !== undefined) {
		const found = await stat(options.path).catch(() => undefined)
		if (!found?.isFile()) {
			throw new CuaDriverUnavailableError(
				`cua-driver was configured at ${options.path}, which is not a file.`,
			)
		}
		return { path: options.path, source: 'configured' }
	}

	const arch = options.arch ?? process.arch
	const asset = options.asset ?? cuaDriverAsset(arch)
	if (!asset) {
		throw new CuaDriverUnavailableError(
			`cua-driver publishes no Windows build for the ${arch} architecture.`,
		)
	}
	const dir = options.cacheDir ?? defaultCuaDriverCacheDir(options.env)
	const exe = join(dir, EXE_NAME)

	if (await isPinnedExecutable(exe, asset.exeSize, asset.exeSha256)) {
		return { path: exe, source: 'cache' }
	}
	if (options.download === false) {
		throw new CuaDriverUnavailableError(
			`cua-driver ${CUA_DRIVER_RELEASE.version} is not in ${dir} and downloading it is turned off.`,
		)
	}

	const url = cuaDriverDownloadUrl(asset.archive)
	const archive = await download(url, options.fetch ?? fetch, options.downloadTimeoutMs ?? 180_000)
	if (archive.length !== asset.archiveSize || sha256(archive) !== asset.archiveSha256) {
		throw new CuaDriverUnavailableError(
			`${url} did not match its pinned SHA-256 (${archive.length} bytes received); nothing was installed.`,
		)
	}
	const content = extractZipEntry(archive, EXE_NAME)
	if (!content || content.length !== asset.exeSize || sha256(content) !== asset.exeSha256) {
		throw new CuaDriverUnavailableError(
			`${asset.archive} passed its checksum but its ${EXE_NAME} did not match the pinned SHA-256; nothing was installed.`,
		)
	}
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const temporary = join(dir, `${EXE_NAME}.${process.pid}.${Date.now()}.partial`)
	try {
		await writeFile(temporary, content, { mode: 0o755 })
		// WSL starts a Windows program only when the Linux file is executable.
		await chmod(temporary, 0o755)
		await rename(temporary, exe)
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined)
		throw new CuaDriverUnavailableError(
			`cua-driver was downloaded and verified but could not be written to ${dir}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const written = await stat(exe)
	verified.set(exe, `${written.size}:${written.mtimeMs}`)
	return { path: exe, source: 'download' }
}

async function isPinnedExecutable(path: string, size: number, digest: string): Promise<boolean> {
	const found = await stat(path).catch(() => undefined)
	if (!found?.isFile() || found.size !== size) return false
	const identity = `${found.size}:${found.mtimeMs}`
	if (verified.get(path) === identity) return true
	const content = await readFile(path).catch(() => undefined)
	if (!content || sha256(content) !== digest) return false
	verified.set(path, identity)
	return true
}

async function download(url: string, fetcher: typeof fetch, timeoutMs: number): Promise<Buffer> {
	let response: Response
	try {
		response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
	} catch (error) {
		throw new CuaDriverUnavailableError(
			`Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!response.ok) {
		throw new CuaDriverUnavailableError(`Could not download ${url}: HTTP ${response.status}.`)
	}
	try {
		return Buffer.from(await response.arrayBuffer())
	} catch (error) {
		throw new CuaDriverUnavailableError(
			`The download of ${url} stopped: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex')
}

/** For tests: forget which executables were verified. */
export function _resetVerifiedCuaDriverCache(): void {
	verified.clear()
}
