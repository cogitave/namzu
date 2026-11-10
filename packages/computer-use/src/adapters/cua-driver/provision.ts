import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { extractZipEntry } from './zip.js'

/**
 * The cua-driver build this package drives on Windows, pinned by version and
 * by SHA-256 of both the release archive and the executable inside it.
 *
 * cua-driver (github.com/trycua/cua, MIT) publishes every build as a GitHub
 * prerelease with a `checksums.txt`; the archive hashes below are the ones it
 * lists for `cua-driver-rs-v0.38.0`, and the executable hashes were taken
 * from those archives. Moving to another build means changing all four and
 * re-running the Windows verification in `docs/sdk/computer-actions.md`.
 */
export const CUA_DRIVER_RELEASE = {
	version: '0.38.0',
	tag: 'cua-driver-rs-v0.38.0',
	baseUrl: 'https://github.com/trycua/cua/releases/download',
	windows: {
		x64: {
			archive: 'cua-driver-rs-0.38.0-windows-x86_64-binary.zip',
			archiveSize: 35_890_999,
			archiveSha256: '5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5',
			exeSize: 38_673_232,
			exeSha256: 'ffa58d88779ee219304b0c307f4cfa970fe822f830c6ecf9254eda5c29e22bf2',
		},
		arm64: {
			archive: 'cua-driver-rs-0.38.0-windows-arm64-binary.zip',
			archiveSize: 33_682_556,
			archiveSha256: 'd25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700',
			exeSize: 32_621_904,
			exeSha256: '2d6a0822be887a8a51678f57682d7362d484d4049b769ef964f0c2dffda29de1',
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
	/**
	 * Told, once and in plain words, before the pinned build is downloaded, so a person
	 * waiting on the first use knows why. Not called when the build is cached.
	 */
	readonly onDownload?: (notice: string) => void
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
		await removeSupersededCuaDrivers(dir, { env: options.env })
		return { path: exe, source: 'cache' }
	}
	if (options.download === false) {
		throw new CuaDriverUnavailableError(
			`cua-driver ${CUA_DRIVER_RELEASE.version} is not in ${dir} and downloading it is turned off.`,
		)
	}

	const url = cuaDriverDownloadUrl(asset.archive)
	options.onDownload?.(
		`Namzu is downloading the computer-use helper (cua-driver ${CUA_DRIVER_RELEASE.version}, about ${Math.max(1, Math.round(asset.archiveSize / 1_000_000))} MB) once. It is checked before it is used, so the first use takes a little longer.`,
	)
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
	await removeSupersededCuaDrivers(dir, { env: options.env })
	return { path: exe, source: 'download' }
}

/** A cache folder named like a release: `0.28.2`. Nothing else in the cache is Namzu's to remove. */
const VERSION_FOLDER = /^\d+\.\d+\.\d+$/

/** A folder touched within this long is not cleaned: someone may be writing into it or about to run it. */
const RECENT_MS = 60 * 60 * 1000

export interface RemoveSupersededOptions {
	readonly env?: NodeJS.ProcessEnv | undefined
	/** The clock, for tests. */
	readonly now?: number
}

const versionParts = (name: string): number[] => name.split('.').map(Number)

function isOlder(candidate: string, pinned: string): boolean {
	const a = versionParts(candidate)
	const b = versionParts(pinned)
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
	}
	return false
}

/**
 * Removes the older builds beside the one in use. `keep` is the folder of the build now in use.
 * Only when it sits in Namzu's own cache (`<NAMZU_HOME>/computer-use/cua-driver/<version>`) are its
 * sibling folders looked at; a cache directory the caller chose is never swept. Only a folder named
 * like a version and strictly older than `keep` is removed, so a newer Namzu's build is never
 * deleted by an older one. A file, a link, a folder with any other name, a folder holding a
 * `.partial` download or touched within the last hour, and the kept folder are left alone, and a
 * build that cannot be removed (still running) is skipped.
 */
export async function removeSupersededCuaDrivers(
	keep: string,
	options: RemoveSupersededOptions = {},
): Promise<string[]> {
	const pinned = basename(keep)
	if (!VERSION_FOLDER.test(pinned)) return []
	const parent = dirname(keep)
	if (resolve(parent) !== resolve(dirname(defaultCuaDriverCacheDir(options.env)))) return []
	const now = options.now ?? Date.now()
	const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
	const removed: string[] = []
	for (const entry of entries) {
		if (!entry.isDirectory() || !VERSION_FOLDER.test(entry.name)) continue
		if (!isOlder(entry.name, pinned)) continue
		const folder = join(parent, entry.name)
		try {
			const found = await stat(folder)
			if (now - found.mtimeMs < RECENT_MS) continue
			if ((await readdir(folder)).some((name) => name.endsWith('.partial'))) continue
			await rm(folder, { recursive: true })
			removed.push(entry.name)
		} catch {
			// In use or protected: it stays, and the next start tries again.
		}
	}
	return removed
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
