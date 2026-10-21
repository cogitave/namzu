import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { AsarError, extractAsar, unsafeComponent } from '../asar.js'
import { sha256 } from './fixtures.js'

/**
 * `fixture.asar` was written by the real packer:
 *
 *   npm i @electron/asar@4.0.1
 *   asar pack tree fixture.asar --unpack '*.node'
 *
 * from a tree of `main.js`, `lib/util.js`, `native/addon.node` and a symlink
 * `link.js -> main.js`. Hostile archives below are built by hand.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const work = mkdtempSync(join(tmpdir(), 'analysis-native-asar-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

let counter = 0
const fresh = () => join(work, `out-${counter++}`)

interface FileSpec {
	size: number
	offset?: string
	unpacked?: boolean
	link?: string
	executable?: boolean
	integrity?: { algorithm: string; hash: string; blockSize: number; blocks: string[] }
}
type Tree = { files: Record<string, Tree | FileSpec> }

/** Pickle-framed header followed by the data. */
function buildAsar(tree: Tree, data: Buffer): Buffer {
	const json = Buffer.from(JSON.stringify(tree))
	const padded = Math.ceil(json.length / 4) * 4
	const header = Buffer.alloc(16 + padded)
	header.writeUInt32LE(4, 0)
	header.writeUInt32LE(8 + padded, 4)
	header.writeUInt32LE(4 + padded, 8)
	header.writeUInt32LE(json.length, 12)
	json.copy(header, 16)
	return Buffer.concat([header, data])
}

const integrityOf = (data: Buffer) => ({
	algorithm: 'SHA256',
	hash: sha256(data),
	blockSize: 4 * 1024 * 1024,
	blocks: [sha256(data)],
})

describe('extractAsar with an archive from the real packer', () => {
	it('writes packed files, reads unpacked ones from the sibling directory, verifies integrity, skips links', async () => {
		const out = fresh()
		const r = await extractAsar(join(fixtures, 'fixture.asar'), out)
		expect(readFileSync(join(out, 'main.js'), 'utf8')).toBe('console.log("main")\n')
		expect(readFileSync(join(out, 'lib', 'util.js'), 'utf8')).toBe('export const x = 1\n')
		expect(readFileSync(join(out, 'native', 'addon.node'), 'utf8')).toBe('NATIVE-ADDON-BYTES')
		expect(existsSync(join(out, 'link.js'))).toBe(false)
		const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]))
		expect(byPath['main.js']).toMatchObject({ status: 'written', verified: true, unpacked: false })
		expect(byPath['native/addon.node']).toMatchObject({
			status: 'written',
			unpacked: true,
			verified: true,
		})
		expect(byPath['link.js']).toMatchObject({
			status: 'skipped',
			reason: expect.stringContaining('symbolic link'),
		})
		expect(r).toMatchObject({ written: 4, skipped: 1, integrityMismatches: 0, headerMatches: null })
		expect(r.headerSha256).toHaveLength(64)
	})

	it('checks the header against an expected hash', async () => {
		const first = await extractAsar(join(fixtures, 'fixture.asar'), fresh())
		const ok = await extractAsar(join(fixtures, 'fixture.asar'), fresh(), {
			expectedHeaderSha256: first.headerSha256.toUpperCase(),
		})
		expect(ok.headerMatches).toBe(true)
		const out = fresh()
		await expect(
			extractAsar(join(fixtures, 'fixture.asar'), out, { expectedHeaderSha256: '0'.repeat(64) }),
		).rejects.toMatchObject({ code: 'header_mismatch' })
		expect(existsSync(out)).toBe(false)
	})

	it('reports a missing unpacked directory per file', async () => {
		const copy = join(work, 'lonely.asar')
		writeFileSync(copy, readFileSync(join(fixtures, 'fixture.asar')))
		const r = await extractAsar(copy, fresh())
		const addon = r.entries.find((e) => e.path === 'native/addon.node')
		expect(addon).toMatchObject({ status: 'skipped', unpacked: true })
		expect(r.written).toBe(3)
	})
})

describe('extractAsar refuses hostile archives', () => {
	const a = Buffer.from('console.log("a")')

	it('keeps traversal, absolute and device names out of the output', async () => {
		const names = ['..', '.', '', 'a/b', 'a\\b', 'C:evil', 'nul', 'con.txt', 'x.', 'bad\u0000name']
		const files: Tree['files'] = { ok: { size: a.length, offset: '0' } }
		for (const n of names) files[n] = { size: a.length, offset: '0' }
		files.dir = {
			files: { '..': { size: a.length, offset: '0' }, fine: { size: a.length, offset: '0' } },
		}
		const archive = join(work, 'hostile.asar')
		writeFileSync(archive, buildAsar({ files }, a))
		const parent = join(work, 'hostile-parent')
		mkdirSync(parent)
		const out = join(parent, 'out')
		const r = await extractAsar(archive, out)
		expect(readdirSync(parent)).toEqual(['out'])
		expect(readdirSync(out).sort()).toEqual(['dir', 'ok'])
		expect(readdirSync(join(out, 'dir'))).toEqual(['fine'])
		expect(r.written).toBe(2)
		expect(r.entries.filter((e) => e.reason?.startsWith('unsafe name')).length).toBe(
			names.length + 1,
		)
	})

	it('skips entries whose data lies outside the archive or whose numbers are wrong', async () => {
		const archive = join(work, 'ranges.asar')
		writeFileSync(
			archive,
			buildAsar(
				{
					files: {
						good: { size: a.length, offset: '0' },
						past: { size: 10, offset: '100000' },
						huge: { size: 2 ** 40, offset: '0' },
						negative: { size: -1, offset: '0' },
						badoffset: { size: 1, offset: '-5' },
						floaty: { size: 1.5, offset: '0' },
						noOffset: { size: 1 } as FileSpec,
					},
				},
				a,
			),
		)
		const r = await extractAsar(archive, fresh())
		expect(r.written).toBe(1)
		expect(r.skipped).toBe(6)
	})

	it('flags a file whose integrity record does not match, and writes it only when told to', async () => {
		const archive = join(work, 'integrity.asar')
		writeFileSync(
			archive,
			buildAsar(
				{
					files: {
						good: { size: a.length, offset: '0', integrity: integrityOf(a) },
						tampered: { size: a.length, offset: '0', integrity: integrityOf(Buffer.from('other')) },
					},
				},
				a,
			),
		)
		const skip = fresh()
		const r = await extractAsar(archive, skip)
		expect(r.integrityMismatches).toBe(1)
		expect(r.entries.find((e) => e.path === 'tampered')).toMatchObject({
			status: 'integrity-mismatch',
		})
		expect(existsSync(join(skip, 'tampered'))).toBe(false)
		const write = fresh()
		const w = await extractAsar(archive, write, { onIntegrityMismatch: 'write' })
		expect(w.entries.find((e) => e.path === 'tampered')).toMatchObject({
			status: 'integrity-mismatch-written',
		})
		expect(existsSync(join(write, 'tampered'))).toBe(true)
	})

	it('rejects a header that lies about its own size', async () => {
		const good = buildAsar({ files: { a: { size: 1, offset: '0' } } }, Buffer.from('x'))
		const cases: [string, Buffer, string][] = [
			['not an asar', Buffer.concat([Buffer.from([9, 0, 0, 0]), good.subarray(4)]), 'bad_header'],
			['pickle size', patch(good, 4, 9999), 'bad_header'],
			['payload size', patch(good, 8, 1), 'bad_header'],
			['json length', patch(good, 12, 0x7fffffff), 'header_too_large'],
			['truncated', good.subarray(0, 20), 'bad_header'],
			['tiny', good.subarray(0, 6), 'bad_header'],
			['json', corruptJson(good), 'bad_header'],
		]
		for (const [name, bytes, code] of cases) {
			const archive = join(work, `${name.replace(/ /g, '-')}.asar`)
			writeFileSync(archive, bytes)
			const out = fresh()
			await expect(extractAsar(archive, out)).rejects.toMatchObject({ code })
			expect(existsSync(out), name).toBe(false)
		}
	})

	it('stops at the file and byte limits', async () => {
		const archive = join(work, 'limits.asar')
		const files: Tree['files'] = {}
		for (let i = 0; i < 5; i++) files[`f${i}`] = { size: 4, offset: String(i * 4) }
		writeFileSync(archive, buildAsar({ files }, Buffer.from('aaaabbbbccccddddeeee')))
		await expect(extractAsar(archive, fresh(), { maxFiles: 3 })).rejects.toMatchObject({
			code: 'too_many_files',
		})
		const r = await extractAsar(archive, fresh(), { maxTotalBytes: 10 })
		expect(r.written).toBe(2)
		expect(r.skipped).toBe(3)
	})

	it('only writes into a new or empty directory', async () => {
		const archive = join(work, 'dirs.asar')
		writeFileSync(archive, buildAsar({ files: { a: { size: 1, offset: '0' } } }, Buffer.from('x')))
		const full = fresh()
		mkdirSync(full)
		writeFileSync(join(full, 'precious'), 'keep')
		await expect(extractAsar(archive, full)).rejects.toMatchObject({ code: 'out_dir_invalid' })
		expect(readFileSync(join(full, 'precious'), 'utf8')).toBe('keep')
		const file = join(work, 'a-file')
		writeFileSync(file, 'x')
		await expect(extractAsar(archive, file)).rejects.toBeInstanceOf(AsarError)
		const empty = fresh()
		mkdirSync(empty)
		expect((await extractAsar(archive, empty)).written).toBe(1)
		if (process.platform !== 'win32') {
			const real = fresh()
			mkdirSync(real)
			const link = fresh()
			symlinkSync(real, link)
			await expect(extractAsar(archive, link)).rejects.toMatchObject({ code: 'out_dir_invalid' })
		}
	})

	it('does not follow a symlink planted in the unpacked directory', async () => {
		if (process.platform === 'win32') return
		const archive = join(work, 'planted.asar')
		writeFileSync(
			archive,
			buildAsar(
				{ files: { 'secret.txt': { size: 6, unpacked: true } as FileSpec } },
				Buffer.alloc(0),
			),
		)
		const secret = join(work, 'outside-secret')
		writeFileSync(secret, 'SECRET')
		mkdirSync(`${archive}.unpacked`)
		symlinkSync(secret, join(`${archive}.unpacked`, 'secret.txt'))
		const r = await extractAsar(archive, fresh())
		expect(r.written).toBe(0)
		expect(r.entries[0]).toMatchObject({
			status: 'skipped',
			reason: expect.stringMatching(/not a regular file|outside the \.asar\.unpacked/),
		})
	})
})

describe('extractAsar against a hostile header and tree', () => {
	it('counts every node the header names against maxFiles, not only files', async () => {
		const archive = join(work, 'nodes.asar')
		const files: Record<string, unknown> = {}
		for (let i = 0; i < 50; i++) files[`n${i}`] = null
		for (let i = 0; i < 50; i++) files[`d${i}`] = { files: {} }
		writeFileSync(archive, buildAsar({ files } as Tree, Buffer.alloc(0)))
		await expect(extractAsar(archive, fresh(), { maxFiles: 60 })).rejects.toMatchObject({
			code: 'too_many_files',
		})
		const r = await extractAsar(archive, fresh(), { maxFiles: 100 })
		expect(r.entries).toHaveLength(50)
	})

	it('does not read through a symlinked directory inside .asar.unpacked', async () => {
		if (process.platform === 'win32') return
		const archive = join(work, 'dirlink.asar')
		writeFileSync(
			archive,
			buildAsar(
				{
					files: {
						sub: { files: { 'secret.txt': { size: 6, unpacked: true } as FileSpec } },
					},
				},
				Buffer.alloc(0),
			),
		)
		const outside = join(work, 'outside-dir')
		mkdirSync(outside)
		writeFileSync(join(outside, 'secret.txt'), 'SECRET')
		mkdirSync(`${archive}.unpacked`)
		symlinkSync(outside, join(`${archive}.unpacked`, 'sub'))
		const out = fresh()
		const r = await extractAsar(archive, out)
		expect(r.written).toBe(0)
		expect(r.entries[0]).toMatchObject({
			status: 'skipped',
			reason: expect.stringContaining('outside'),
		})
		expect(existsSync(join(out, 'sub', 'secret.txt'))).toBe(false)
	})

	it('refuses an archive path that is a symbolic link', async () => {
		if (process.platform === 'win32') return
		const real = join(work, 'real.asar')
		writeFileSync(real, buildAsar({ files: { a: { size: 1, offset: '0' } } }, Buffer.from('x')))
		const link = join(work, 'link.asar')
		symlinkSync(real, link)
		await expect(extractAsar(link, fresh())).rejects.toMatchObject({ code: 'io_error' })
	})

	it('never marks a written file executable, whatever the header says', async () => {
		if (process.platform === 'win32') return
		const archive = join(work, 'exec.asar')
		writeFileSync(
			archive,
			buildAsar({ files: { run: { size: 1, offset: '0', executable: true } } }, Buffer.from('x')),
		)
		const out = fresh()
		await extractAsar(archive, out)
		expect(statSync(join(out, 'run')).mode & 0o111).toBe(0)
	})
})

describe('unsafeComponent', () => {
	it('accepts ordinary names and refuses the rest', () => {
		for (const ok of ['main.js', 'node_modules', '.hidden', 'a b', 'ü.txt']) {
			expect(unsafeComponent(ok), ok).toBeNull()
		}
		for (const bad of [
			'',
			'.',
			'..',
			'a/b',
			'a\\b',
			'a:b',
			'x\u0001y',
			'trail.',
			'trail ',
			'NUL',
			'com1.txt',
			'a'.repeat(256),
		]) {
			expect(unsafeComponent(bad), JSON.stringify(bad)).not.toBeNull()
		}
	})
})

function patch(buf: Buffer, at: number, value: number): Buffer {
	const copy = Buffer.from(buf)
	copy.writeUInt32LE(value, at)
	return copy
}

function corruptJson(buf: Buffer): Buffer {
	const copy = Buffer.from(buf)
	copy[16] = 0x7b + 1
	return copy
}
