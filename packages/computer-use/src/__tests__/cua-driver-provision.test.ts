import { createHash } from 'node:crypto'
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	CUA_DRIVER_RELEASE,
	CuaDriverUnavailableError,
	_resetVerifiedCuaDriverCache,
	cuaDriverAsset,
	cuaDriverDownloadUrl,
	defaultCuaDriverCacheDir,
	removeSupersededCuaDrivers,
	resolveCuaDriver,
} from '../adapters/cua-driver/provision.js'
import { ZipFormatError, extractZipEntry } from '../adapters/cua-driver/zip.js'

/** A ZIP archive with the given entries, deflated unless `store` names them. */
function makeZip(entries: Record<string, Buffer>, store: readonly string[] = []): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const [name, content] of Object.entries(entries)) {
		const method = store.includes(name) ? 0 : 8
		const data = method === 8 ? deflateRawSync(content) : content
		const nameBytes = Buffer.from(name, 'utf8')
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(method, 8)
		local.writeUInt32LE(data.length, 18)
		local.writeUInt32LE(content.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(method, 10)
		central.writeUInt32LE(data.length, 20)
		central.writeUInt32LE(content.length, 24)
		central.writeUInt16LE(nameBytes.length, 28)
		central.writeUInt32LE(offset, 42)
		locals.push(local, nameBytes, data)
		centrals.push(central, nameBytes)
		offset += local.length + nameBytes.length + data.length
	}
	const directory = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(Object.keys(entries).length, 8)
	end.writeUInt16LE(Object.keys(entries).length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, directory, end])
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('taking one file out of a ZIP archive', () => {
	it('inflates a deflated entry and copies a stored one', () => {
		const exe = Buffer.from('MZ'.padEnd(10_000, 'x'))
		const zip = makeZip({ 'readme.txt': Buffer.from('hi'), 'cua-driver.exe': exe }, ['readme.txt'])
		expect(extractZipEntry(zip, 'cua-driver.exe')).toEqual(exe)
		expect(extractZipEntry(zip, 'readme.txt')?.toString()).toBe('hi')
		expect(extractZipEntry(zip, 'missing.exe')).toBeUndefined()
	})

	it('refuses something that is not a ZIP archive', () => {
		expect(() => extractZipEntry(Buffer.from('not a zip at all, just text'), 'x')).toThrow(
			ZipFormatError,
		)
		expect(() => extractZipEntry(Buffer.alloc(3), 'x')).toThrow(/too short/)
	})

	it('refuses an entry whose size does not match its directory record', () => {
		const zip = makeZip({ 'a.exe': Buffer.from('abcdef') }, ['a.exe'])
		// Claim 7 uncompressed bytes in the central directory.
		const directoryAt = zip.readUInt32LE(zip.length - 22 + 16)
		zip.writeUInt32LE(7, directoryAt + 24)
		expect(() => extractZipEntry(zip, 'a.exe')).toThrow(/directory says 7/)
	})
})

describe('the pinned cua-driver build', () => {
	it('is pinned for both Windows architectures cua-driver publishes, and nothing else', () => {
		expect(cuaDriverAsset('x64')?.archive).toBe('cua-driver-rs-0.38.0-windows-x86_64-binary.zip')
		expect(cuaDriverAsset('arm64')?.archive).toBe('cua-driver-rs-0.38.0-windows-arm64-binary.zip')
		expect(cuaDriverAsset('ia32')).toBeUndefined()
		for (const pin of Object.values(CUA_DRIVER_RELEASE.windows)) {
			expect(pin.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
			expect(pin.exeSha256).toMatch(/^[0-9a-f]{64}$/)
		}
		expect(cuaDriverDownloadUrl('a.zip')).toBe(
			'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/a.zip',
		)
	})

	it('lives under NAMZU_HOME, versioned', () => {
		expect(defaultCuaDriverCacheDir({ NAMZU_HOME: '/srv/namzu' })).toBe(
			'/srv/namzu/computer-use/cua-driver/0.38.0',
		)
	})
})

describe('resolving cua-driver', () => {
	let dir: string
	const exe = Buffer.from('MZ pretend windows executable '.repeat(500))
	const archive = makeZip({ 'cua-driver.exe': exe, 'cua_driver_sdk.dll': Buffer.from('dll') })
	const asset = {
		archive: 'test.zip',
		archiveSize: archive.length,
		archiveSha256: sha256(archive),
		exeSize: exe.length,
		exeSha256: sha256(exe),
	}
	const serving = (body: Buffer, status = 200) =>
		vi.fn(async () => new Response(new Uint8Array(body), { status })) as unknown as typeof fetch

	beforeEach(async () => {
		_resetVerifiedCuaDriverCache()
		dir = await mkdtemp(join(tmpdir(), 'namzu-cua-driver-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('downloads, checks both hashes, writes an executable file, and serves the cache afterwards', async () => {
		const fetcher = serving(archive)
		const first = await resolveCuaDriver({ cacheDir: dir, asset, fetch: fetcher })
		expect(first).toEqual({ path: join(dir, 'cua-driver.exe'), source: 'download' })
		expect(await readFile(first.path)).toEqual(exe)
		expect((await stat(first.path)).mode & 0o111).not.toBe(0)
		expect(await readdir(dir)).toEqual(['cua-driver.exe'])

		_resetVerifiedCuaDriverCache()
		const second = await resolveCuaDriver({ cacheDir: dir, asset, fetch: fetcher })
		expect(second.source).toBe('cache')
		expect(fetcher).toHaveBeenCalledTimes(1)
	})

	it('installs nothing when the archive does not match its pin', async () => {
		const tampered = Buffer.from(archive)
		tampered[40] = (tampered[40] ?? 0) ^ 0xff
		await expect(
			resolveCuaDriver({ cacheDir: dir, asset, fetch: serving(tampered) }),
		).rejects.toThrow(/did not match its pinned SHA-256/)
		expect(await readdir(dir)).toEqual([])
	})

	it('installs nothing when the executable inside does not match its pin', async () => {
		await expect(
			resolveCuaDriver({
				cacheDir: dir,
				asset: { ...asset, exeSha256: '0'.repeat(64) },
				fetch: serving(archive),
			}),
		).rejects.toThrow(/cua-driver\.exe did not match/)
		expect(await readdir(dir)).toEqual([])
	})

	it('replaces a cached executable that no longer matches its pin', async () => {
		await writeFile(join(dir, 'cua-driver.exe'), Buffer.alloc(exe.length, 1))
		const fetcher = serving(archive)
		const resolved = await resolveCuaDriver({ cacheDir: dir, asset, fetch: fetcher })
		expect(resolved.source).toBe('download')
		expect(await readFile(resolved.path)).toEqual(exe)
	})

	it('says why when downloading is off, the server refuses, or the network fails', async () => {
		await expect(resolveCuaDriver({ cacheDir: dir, asset, download: false })).rejects.toThrow(
			/downloading it is turned off/,
		)
		await expect(
			resolveCuaDriver({ cacheDir: dir, asset, fetch: serving(Buffer.alloc(0), 404) }),
		).rejects.toThrow(/HTTP 404/)
		const offline = vi.fn(async () => {
			throw new TypeError('fetch failed')
		}) as unknown as typeof fetch
		const error = await resolveCuaDriver({ cacheDir: dir, asset, fetch: offline }).catch(
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(CuaDriverUnavailableError)
		expect((error as Error).message).toMatch(/fetch failed/)
	})

	it('uses a configured executable as it is, and refuses one that is not there', async () => {
		const own = join(dir, 'my-cua-driver.exe')
		await writeFile(own, 'anything')
		await expect(resolveCuaDriver({ path: own })).resolves.toEqual({
			path: own,
			source: 'configured',
		})
		await expect(resolveCuaDriver({ path: join(dir, 'nope.exe') })).rejects.toThrow(/not a file/)
	})

	it('refuses an architecture cua-driver does not build for', async () => {
		await expect(resolveCuaDriver({ cacheDir: dir, arch: 'ia32' })).rejects.toThrow(/ia32/)
	})
})

/** Makes a folder look untouched for a day, so the cleanup does not take it for a download in progress. */
const age = (folder: string) => {
	const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
	return utimes(folder, old, old)
}

describe('the cache of cua-driver builds', () => {
	let root: string
	const env = () => ({ NAMZU_HOME: root })
	let cache: string
	const exe = Buffer.from('MZ pretend windows executable '.repeat(500))
	const archive = makeZip({ 'cua-driver.exe': exe })
	const asset = {
		archive: 'test.zip',
		archiveSize: archive.length,
		archiveSha256: sha256(archive),
		exeSize: exe.length,
		exeSha256: sha256(exe),
	}
	const fetcher = () =>
		vi.fn(async () => new Response(new Uint8Array(archive))) as unknown as typeof fetch

	beforeEach(async () => {
		_resetVerifiedCuaDriverCache()
		root = await mkdtemp(join(tmpdir(), 'namzu-cua-cache-'))
		cache = join(root, 'computer-use', 'cua-driver')
		await mkdir(join(cache, '0.28.2'), { recursive: true })
		await writeFile(join(cache, '0.28.2', 'cua-driver.exe'), 'old')
		await age(join(cache, '0.28.2'))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('downloads the pinned build when only an older one is cached, says so once, and removes the older one', async () => {
		const notices: string[] = []
		const dir = join(cache, CUA_DRIVER_RELEASE.version)
		const resolved = await resolveCuaDriver({
			cacheDir: dir,
			env: env(),
			asset,
			fetch: fetcher(),
			onDownload: (notice) => notices.push(notice),
		})
		expect(resolved.source).toBe('download')
		expect(notices).toHaveLength(1)
		expect(notices[0]).toMatch(/downloading the computer-use helper/)
		expect(await readdir(cache)).toEqual([CUA_DRIVER_RELEASE.version])

		// The next use is the cache: no download, no second notice.
		_resetVerifiedCuaDriverCache()
		const again = await resolveCuaDriver({
			cacheDir: dir,
			asset,
			fetch: fetcher(),
			onDownload: (notice) => notices.push(notice),
		})
		expect(again.source).toBe('cache')
		expect(notices).toHaveLength(1)
	})

	it('removes only older version folders, never the one in use or anything else', async () => {
		const keep = join(cache, '0.38.0')
		await mkdir(keep)
		await mkdir(join(cache, '0.30.1'))
		await age(join(cache, '0.30.1'))
		await mkdir(join(cache, '0.39.0'))
		await age(join(cache, '0.39.0'))
		await mkdir(join(cache, 'notes'))
		await mkdir(join(cache, '0.30'))
		await writeFile(join(cache, '0.31.0'), 'a file named like a version')
		const outside = join(root, 'outside')
		await mkdir(outside)
		await symlink(outside, join(cache, '0.32.0'), 'dir')
		const removed = await removeSupersededCuaDrivers(keep, { env: env() })
		expect(removed.sort()).toEqual(['0.28.2', '0.30.1'])
		expect((await readdir(cache)).sort()).toEqual([
			'0.30',
			'0.31.0',
			'0.32.0',
			'0.38.0',
			'0.39.0',
			'notes',
		])
		expect(await readdir(outside)).toEqual([])
	})

	it('leaves a folder alone when the build in use is not in a version folder', async () => {
		const custom = join(cache, 'custom')
		await mkdir(custom)
		await expect(removeSupersededCuaDrivers(custom, { env: env() })).resolves.toEqual([])
		expect(await readdir(cache)).toContain('0.28.2')
	})

	it('never sweeps a cache directory the caller chose, even one named like a version', async () => {
		const chosen = join(root, 'data', '1.0.0')
		await mkdir(chosen, { recursive: true })
		const neighbour = join(root, 'data', '0.5.0')
		await mkdir(neighbour)
		await age(neighbour)
		await expect(removeSupersededCuaDrivers(chosen, { env: env() })).resolves.toEqual([])
		expect(await readdir(join(root, 'data'))).toContain('0.5.0')
	})

	it('leaves a folder with a download in progress or touched recently', async () => {
		const keep = join(cache, '0.38.0')
		await mkdir(keep)
		const partial = join(cache, '0.30.1')
		await mkdir(partial)
		await writeFile(join(partial, 'cua-driver.exe.1.2.partial'), 'half')
		await age(partial)
		await mkdir(join(cache, '0.31.1')) // just created: recent
		const removed = await removeSupersededCuaDrivers(keep, { env: env() })
		expect(removed).toEqual(['0.28.2'])
		expect((await readdir(cache)).sort()).toEqual(['0.30.1', '0.31.1', '0.38.0'])
	})

	it('does not tell the person anything for a build that is already cached', async () => {
		const dir = join(cache, CUA_DRIVER_RELEASE.version)
		await resolveCuaDriver({ cacheDir: dir, asset, fetch: fetcher() })
		_resetVerifiedCuaDriverCache()
		const notices: string[] = []
		await resolveCuaDriver({
			cacheDir: dir,
			asset,
			download: false,
			onDownload: (n) => notices.push(n),
		})
		expect(notices).toEqual([])
	})
})
