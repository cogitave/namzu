import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArchiveError, type ArchiveErrorCode, extractArchive } from './archive.js'
import { parseFilesList, refuseName, verifyFolderFully } from './files-list.js'
import { nodeFs } from './fs.js'
import {
	type BuiltArchive,
	type TarEntry,
	buildArchive,
	chunks,
	faultyFs,
	filesJsonOf,
	kernelFiles,
	sha512,
	tarBytes,
} from './kernel-test-support.js'

let work: string
beforeEach(async () => {
	work = await mkdtemp(join(tmpdir(), 'namzu-archive-test-'))
})
afterEach(async () => {
	await rm(work, { recursive: true, force: true })
})

const files = kernelFiles('51.3.0', '62.14.0')

async function extract(
	built: BuiltArchive,
	override: Partial<BuiltArchive['bundle']> = {},
	source: AsyncIterable<Uint8Array> = chunks(built.gz),
) {
	const target = join(work, 'out')
	const limits = { ...built.bundle, ...override }
	try {
		const result = await extractArchive({
			source,
			target,
			fs: nodeFs,
			limits: {
				fileCount: limits.fileCount,
				unpackedSize: limits.unpackedSize,
				filesSha512: limits.filesSha512,
			},
		})
		return { result, target }
	} catch (error) {
		// whatever a refusal leaves behind: nothing
		expect(await stat(target).catch(() => undefined), 'the target is removed').toBeUndefined()
		throw error
	}
}

async function codeOf(promise: Promise<unknown>): Promise<ArchiveErrorCode | string> {
	try {
		await promise
	} catch (error) {
		return error instanceof ArchiveError ? error.code : `other:${String(error)}`
	}
	return 'accepted'
}

describe('a good archive', () => {
	it('unpacks every file, with files.json, each equal to what was packed', async () => {
		const built = buildArchive('51.3.0', files)
		const { result, target } = await extract(built)
		expect(result.list.files.map((file) => file.path)).toEqual(Object.keys(files).sort())
		for (const [name, text] of Object.entries(files))
			expect((await readFile(join(target, ...name.split('/')))).toString()).toBe(text)
		expect((await readFile(join(target, 'files.json'))).equals(built.filesJson)).toBe(true)
		expect(await verifyFolderFully(nodeFs, target, result.list)).toBeUndefined()
	})

	it('reads a name longer than 100 bytes from a pax header, and a name with non-ASCII letters', async () => {
		const long = `node_modules/${'a'.repeat(60)}/${'b'.repeat(60)}/index.js`
		const more = { ...files, [long]: 'long', 'dist/çok-güzel.js': 'x' }
		const { target } = await extract(buildArchive('51.3.0', more))
		expect((await readFile(join(target, ...long.split('/')))).toString()).toBe('long')
		expect((await readFile(join(target, 'dist', 'çok-güzel.js'))).toString()).toBe('x')
	})

	it('reads an archive whose files are bigger than one copy chunk', async () => {
		const big = Buffer.alloc(300_000, 'z')
		const built = buildArchive('51.3.0', { ...files, 'dist/big.bin': big })
		const { target } = await extract(built)
		expect((await readFile(join(target, 'dist', 'big.bin'))).equals(big)).toBe(true)
	})

	it('gives the same bytes for the same input', () => {
		expect(buildArchive('51.3.0', files).gz.equals(buildArchive('51.3.0', files).gz)).toBe(true)
	})

	it('twice into two folders gives the same result', async () => {
		const built = buildArchive('51.3.0', files)
		const one = await extract(built)
		await rm(one.target, { recursive: true })
		const two = await extract(built)
		expect(two.result.list).toEqual(one.result.list)
	})
})

describe('every refusal', () => {
	const entryTests: [string, (entries: TarEntry[]) => TarEntry[], ArchiveErrorCode][] = [
		[
			'a symbolic link',
			(e) => [...e, { name: 'dist/link.js', type: '2', linkname: '/etc/passwd' }],
			'entry-type',
		],
		[
			'a hard link',
			(e) => [...e, { name: 'dist/hard.js', type: '1', linkname: 'dist/bin.js' }],
			'entry-type',
		],
		[
			'a directory entry',
			(e) => [e[0] as TarEntry, { name: 'dist', type: '5' }, ...e.slice(1)],
			'entry-type',
		],
		['a device', (e) => [...e, { name: 'dev', type: '3' }], 'entry-type'],
		[
			'an old-style regular file with no type',
			(e) => e.map((x) => (x.name === 'package.json' ? { ...x, type: '\0' } : x)),
			'entry-type',
		],
		[
			'a global pax header',
			(e) => [{ name: 'g', type: 'g', data: '30 mtime=0\n'.padEnd(30, 'x') }, ...e],
			'entry-type',
		],
		[
			'a pax key other than path',
			(e) =>
				e.map((x) =>
					x.name === 'package.json' ? { ...x, paxPath: true, pax: { mtime: '1' } } : x,
				),
			'pax',
		],
		[
			'a linkpath in pax',
			(e) =>
				e.map((x) =>
					x.name === 'package.json' ? { ...x, paxPath: true, pax: { linkpath: 'x' } } : x,
				),
			'pax',
		],
		[
			'a link target on a plain file',
			(e) => e.map((x) => (x.name === 'package.json' ? { ...x, linkname: 'x' } : x)),
			'entry-type',
		],
		[
			'a path prefix',
			(e) => e.map((x) => (x.name === 'package.json' ? { ...x, prefix: 'dist' } : x)),
			'header',
		],
		[
			'a bad checksum',
			(e) => e.map((x) => (x.name === 'package.json' ? { ...x, badChecksum: true } : x)),
			'header',
		],
		['an absolute path', (e) => [...e, { name: '/etc/evil', data: 'x' }], 'name'],
		['a traversal', (e) => [...e, { name: '../evil', data: 'x' }], 'name'],
		['a traversal in the middle', (e) => [...e, { name: 'dist/../../evil', data: 'x' }], 'name'],
		['a drive letter', (e) => [...e, { name: 'C:evil', data: 'x' }], 'name'],
		['a backslash', (e) => [...e, { name: 'dist\\evil.js', data: 'x' }], 'name'],
		['a colon', (e) => [...e, { name: 'dist/a:b', data: 'x' }], 'name'],
		['an empty segment', (e) => [...e, { name: 'dist//evil', data: 'x' }], 'name'],
		['a dot segment', (e) => [...e, { name: 'dist/./evil', data: 'x' }], 'name'],
		['a reserved device name', (e) => [...e, { name: 'dist/CON', data: 'x' }], 'name'],
		[
			'a reserved device name with an extension',
			(e) => [...e, { name: 'dist/nul.txt', data: 'x' }],
			'name',
		],
		['a reserved numbered device name', (e) => [...e, { name: 'dist/Com3.js', data: 'x' }], 'name'],
		['a segment ending with a dot', (e) => [...e, { name: 'dist/evil.', data: 'x' }], 'name'],
		['a segment ending with a space', (e) => [...e, { name: 'dist/evil ', data: 'x' }], 'name'],
		['a control character', (e) => [...e, { name: 'dist/ev\u0001il', data: 'x' }], 'name'],
	]
	for (const [label, change, code] of entryTests)
		it(`refuses ${label}`, async () => {
			const built = buildArchive('51.3.0', files, { entries: change })
			expect(await codeOf(extract(built))).toBe(code)
		})

	it('refuses two names that are one after case folding (both listed)', async () => {
		const more = { ...files, 'dist/Readme.md': 'a', 'dist/README.md': 'b' }
		expect(await codeOf(extract(buildArchive('51.3.0', more)))).toBe('collision')
	})

	it('refuses a file and a folder under one name', async () => {
		const more = { ...files, 'dist/chunk-one.js/inner.js': 'x' }
		expect(await codeOf(extract(buildArchive('51.3.0', more)))).toBe('collision')
	})

	it('refuses an entry that differs from a listed name only by case', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) => [...e, { name: 'DIST/BIN.JS', data: 'evil' }],
		})
		expect(await codeOf(extract(built))).toBe('unlisted')
	})

	it('refuses a file that files.json does not list', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) => [...e, { name: 'dist/extra.js', data: 'evil' }],
		})
		expect(await codeOf(extract(built))).toBe('unlisted')
	})

	it('refuses a listed file that is missing', async () => {
		// the last listed file is the one that goes missing: the entries before it are in order
		const built = buildArchive('51.3.0', files, {
			entries: (e) => e.filter((x) => x.name !== 'package.json'),
		})
		expect(await codeOf(extract(built))).toBe('missing')
	})

	it('refuses entries that are not in the order of files.json, and a listed file missing in the middle', async () => {
		const swapped = buildArchive('51.3.0', files, {
			entries: (e) => [e[0] as TarEntry, e[2] as TarEntry, e[1] as TarEntry, ...e.slice(3)],
		})
		expect(await codeOf(extract(swapped))).toBe('order')
		const gap = buildArchive('51.3.0', files, {
			entries: (e) => e.filter((x) => x.name !== 'dist/chunk-one.js'),
		})
		expect(await codeOf(extract(gap))).toBe('order')
	})

	it('refuses the same file twice', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) => [...e, e.find((x) => x.name === 'package.json') as TarEntry],
		})
		expect(await codeOf(extract(built))).toBe('duplicate')
	})

	it('refuses a file whose content differs from its hash', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) =>
				e.map((x) => (x.name === 'dist/bin.js' ? { ...x, data: '// bin 51.3.9\n' } : x)),
		})
		expect(await codeOf(extract(built))).toBe('hash')
	})

	it('refuses a file whose size differs from files.json', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) =>
				e.map((x) =>
					x.name === 'dist/bin.js' ? { ...x, data: `${files['dist/bin.js']}more` } : x,
				),
		})
		expect(await codeOf(extract(built))).toBe('size')
	})

	it('refuses more files than the manifest states', async () => {
		const built = buildArchive('51.3.0', files)
		expect(await codeOf(extract(built, { fileCount: built.bundle.fileCount - 1 }))).toBe(
			'too-many-files',
		)
	})

	it('refuses more unpacked bytes than the manifest states', async () => {
		const built = buildArchive('51.3.0', files)
		expect(await codeOf(extract(built, { unpackedSize: built.bundle.unpackedSize - 1 }))).toBe(
			'too-many-bytes',
		)
	})

	it('refuses an archive that unpacks to more than stated even when files.json lies', async () => {
		// files.json lists a small file; the entry carries far more than it says.
		const lying = { ...files, 'dist/small.js': 'x' }
		const built = buildArchive('51.3.0', lying, {
			entries: (e) =>
				e.map((x) =>
					x.name === 'dist/small.js' ? { ...x, data: Buffer.alloc(5_000_000, 'x') } : x,
				),
		})
		const code = await codeOf(extract(built))
		expect(['size', 'too-many-bytes']).toContain(code)
	})

	it('refuses a gzip bomb: garbage that expands past the stated size', async () => {
		const built = buildArchive('51.3.0', files, {
			gzip: (tar) =>
				gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), Buffer.alloc(40_000_000)])),
		})
		const code = await codeOf(extract(built, {}, chunks(built.gz)))
		expect(['too-many-bytes', 'trailing', 'header']).toContain(code)
		expect(code).not.toBe('accepted')
	})

	it('refuses bytes after the end blocks', async () => {
		const built = buildArchive('51.3.0', files, { trailing: Buffer.from('trailing') })
		expect(await codeOf(extract(built))).toBe('trailing')
		const padded = buildArchive('51.3.0', files, { trailing: Buffer.alloc(512) })
		expect(await codeOf(extract(padded))).toBe('trailing')
	})

	it('refuses an end of one block', async () => {
		const built = buildArchive('51.3.0', files, { endBlocks: 1 })
		expect(['header', 'truncated']).toContain(await codeOf(extract(built)))
	})

	it('refuses an archive without end blocks', async () => {
		const built = buildArchive('51.3.0', files, { endBlocks: 0 })
		expect(await codeOf(extract(built))).toBe('truncated')
	})

	it('refuses a truncated archive and a truncated gzip', async () => {
		const built = buildArchive('51.3.0', files)
		const cut = built.gz.subarray(0, built.gz.length - 40)
		expect(['truncated', 'gzip']).toContain(await codeOf(extract(built, {}, chunks(cut))))
		expect(
			await codeOf(extract(built, {}, chunks(Buffer.from('not gzip at all, definitely')))),
		).toBe('gzip')
	})

	it('refuses an archive whose files.json is not the one the manifest names', async () => {
		const built = buildArchive('51.3.0', files)
		expect(await codeOf(extract(built, { filesSha512: sha512('other') }))).toBe('files-list')
	})

	it('refuses an archive that does not start with files.json', async () => {
		const built = buildArchive('51.3.0', files, {
			entries: (e) => [...e.slice(1), e[0] as TarEntry],
		})
		expect(await codeOf(extract(built))).toBe('files-list')
	})

	it('refuses a files.json that lists itself, is unsorted, or has unknown fields', async () => {
		const sortedList = filesJsonOf(files)
		const parsed = JSON.parse(sortedList.toString())
		const cases: [string, Buffer][] = [
			[
				'unsorted',
				Buffer.from(`${JSON.stringify({ ...parsed, files: [...parsed.files].reverse() })}\n`),
			],
			['unknown', Buffer.from(`${JSON.stringify({ ...parsed, extra: 1 })}\n`)],
			[
				'unknown entry field',
				Buffer.from(
					`${JSON.stringify({ ...parsed, files: parsed.files.map((x: object) => ({ ...x, mode: 1 })) })}\n`,
				),
			],
			[
				'self',
				Buffer.from(
					`${JSON.stringify({ ...parsed, files: [{ path: 'files.json', size: 1, sha256: 'a'.repeat(64) }, ...parsed.files] })}\n`,
				),
			],
			[
				'bad hash',
				Buffer.from(
					`${JSON.stringify({ ...parsed, files: parsed.files.map((x: any) => ({ ...x, sha256: 'xyz' })) })}\n`,
				),
			],
			[
				'traversal',
				Buffer.from(
					`${JSON.stringify({ ...parsed, files: [{ path: '../x', size: 0, sha256: 'a'.repeat(64) }, ...parsed.files] })}\n`,
				),
			],
		]
		for (const [label, bytes] of cases) {
			const built = buildArchive('51.3.0', files, { filesJson: bytes })
			expect(['files-list', 'name'], label).toContain(await codeOf(extract(built)))
		}
	})
})

describe('writing', () => {
	it('never writes outside the target and never follows a link that is already there', async () => {
		const outside = join(work, 'outside')
		await mkdir(outside)
		const target = join(work, 'out')
		// A target that already exists is refused outright.
		await mkdir(target)
		const built = buildArchive('51.3.0', files)
		await expect(
			extractArchive({ source: chunks(built.gz), target, fs: nodeFs, limits: { ...built.bundle } }),
		).rejects.toThrow()
		expect(await readdir(target)).toEqual([])
		// A link planted in a fresh target before a file is created through it is not followed.
		const fs2 = {
			...nodeFs,
			openWrite: async (path: string) => {
				if (path.endsWith('chunk-one.js'))
					await symlink(join(outside, 'victim'), path).catch(() => undefined)
				return nodeFs.openWrite(path)
			},
		}
		await rm(target, { recursive: true })
		await expect(
			extractArchive({ source: chunks(built.gz), target, fs: fs2, limits: { ...built.bundle } }),
		).rejects.toThrow()
		expect(await readdir(outside)).toEqual([])
	})

	it('cleans up when a file write fails part way, and leaves nothing', async () => {
		const built = buildArchive('51.3.0', files)
		const target = join(work, 'out')
		const probe = faultyFs(nodeFs)
		await extractArchive({
			source: chunks(built.gz),
			target,
			fs: probe.fs,
			limits: { ...built.bundle },
		})
		await rm(target, { recursive: true })
		for (let at = 1; at <= probe.ops.length; at++) {
			const faulty = faultyFs(nodeFs, { at, mode: 'once' })
			await expect(
				extractArchive({
					source: chunks(built.gz),
					target,
					fs: faulty.fs,
					limits: { ...built.bundle },
				}),
			).rejects.toThrow()
			expect(await stat(target).catch(() => undefined), `after failing op ${at}`).toBeUndefined()
		}
	})
})

describe('names', () => {
	it('accepts ordinary paths', () => {
		for (const name of [
			'dist/bin.js',
			'node_modules/@namzu/sdk/package.json',
			'a b/c.d',
			'dist/con-text.js',
			'console.js',
		])
			expect(refuseName(name), name).toBeUndefined()
	})
	it('parses a list the publisher wrote', () => {
		expect(parseFilesList(filesJsonOf(files)).files).toHaveLength(Object.keys(files).length)
	})
})

describe('the full check of an unpacked folder', () => {
	it('finds a changed byte, a missing file, an extra file and a link', async () => {
		const built = buildArchive('51.3.0', files)
		const { result, target } = await extract(built)
		expect(await verifyFolderFully(nodeFs, target, result.list)).toBeUndefined()
		const { writeFile, unlink } = await import('node:fs/promises')
		await writeFile(join(target, 'dist', 'bin.js'), '// bin 51.3.0\n!')
		expect(await verifyFolderFully(nodeFs, target, result.list)).toMatch(/dist\/bin\.js/u)
		await writeFile(join(target, 'dist', 'bin.js'), files['dist/bin.js'] as string)
		await writeFile(join(target, 'dist', 'extra.js'), 'x')
		expect(await verifyFolderFully(nodeFs, target, result.list)).toMatch(/not listed/u)
		await unlink(join(target, 'dist', 'extra.js'))
		await unlink(join(target, 'dist', 'chunk-one.js'))
		expect(await verifyFolderFully(nodeFs, target, result.list)).toMatch(/missing/u)
		await symlink(join(target, 'package.json'), join(target, 'dist', 'chunk-one.js'))
		expect(await verifyFolderFully(nodeFs, target, result.list)).toMatch(/not a plain file/u)
	})
})

void tarBytes
