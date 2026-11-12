import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { ArchiveRefusal, readArchive, refusalForName } from '../kernel/archive-reader.mjs'
import { buildFilesList, filesJsonBytes, writeArchive } from '../kernel/archive-writer.mjs'
import { END, archive, goodParts, listBytes, paxEntry, sha256, smallKernelFiles, tarEntry, tempDir, writeTree } from './kernel-helpers.mjs'

async function pack(files) {
	const root = tempDir('kernel-src')
	const out = tempDir('kernel-out')
	writeTree(root, files)
	const archivePath = join(out, 'a.tar.gz')
	const result = await writeArchive({ root, archivePath, filesJsonPath: join(out, 'files.json') })
	return { root, out, archivePath, ...result }
}

test('the writer and the independent reader agree on a real small folder', async () => {
	const files = smallKernelFiles()
	const packed = await pack(files)
	const read = await readArchive(packed.archivePath, {
		limits: { fileCount: packed.bundle.fileCount, unpackedSize: packed.bundle.unpackedSize },
	})
	assert.equal(read.list.files.length, Object.keys(files).length)
	for (const [path, data] of Object.entries(files)) assert.equal(read.files.get(path).sha256, sha256(data), path)
	assert.deepEqual(read.filesJson, readFileSync(join(packed.out, 'files.json')))
	assert.equal(packed.bundle.fileCount, Object.keys(files).length)
	assert.equal(packed.bundle.unpackedSize, Object.values(files).reduce((n, d) => n + Buffer.byteLength(d), 0))
	// A long name went through a pax header, and a stock tar reads the result.
	const names = execFileSync('tar', ['-tzf', packed.archivePath]).toString().split('\n')
	assert.equal(names[0], 'files.json')
	assert.ok(names.some((name) => Buffer.byteLength(name) > 100))
})

test('files.json follows the text: sorted by code unit, compact JSON, one newline, itself not listed', async () => {
	const packed = await pack({ 'b.txt': 'b', 'B.txt': 'B', 'a/z.txt': 'z', 'a.txt': 'a' })
	const text = readFileSync(join(packed.out, 'files.json'), 'utf8')
	assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'))
	assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`)
	assert.deepEqual(JSON.parse(text).files.map((f) => f.path), ['B.txt', 'a.txt', 'a/z.txt', 'b.txt'])
	assert.equal(text.includes('"files.json"'), false)
})

test('the same folder gives the same bytes, and the gzip header carries no time and no file name', async () => {
	const files = smallKernelFiles()
	const first = await pack(files)
	const second = await pack(files)
	const a = readFileSync(first.archivePath)
	assert.deepEqual(a, readFileSync(second.archivePath))
	assert.deepEqual([...a.subarray(0, 4)], [0x1f, 0x8b, 0x08, 0x00]) // method deflate, no flags: no name, no extra, no comment
	assert.deepEqual([...a.subarray(4, 8)], [0, 0, 0, 0]) // mtime 0
	assert.equal(a[9], 3) // operating system byte pinned to Unix
	// The tar inside: mode 0644, uid/gid 0, mtime 0, no names.
	const tar = Buffer.from(execFileSync('gzip', ['-dc', first.archivePath], { maxBuffer: 1 << 28 }))
	let at = 0
	let seen = 0
	while (at < tar.length && tar[at] !== 0) {
		const block = tar.subarray(at, at + 512)
		const field = (from, to) => block.subarray(from, to).toString('latin1').replace(/\0.*$/s, '')
		assert.equal(field(100, 108), '0000644')
		assert.equal(Number.parseInt(field(108, 116), 8), 0)
		assert.equal(Number.parseInt(field(116, 124), 8), 0)
		assert.equal(Number.parseInt(field(136, 148), 8), 0)
		assert.equal(field(265, 297), '')
		assert.equal(field(297, 329), '')
		assert.ok(['0', 'x'].includes(String.fromCharCode(block[156])))
		const size = Number.parseInt(field(124, 136), 8)
		at += 512 + Math.ceil(size / 512) * 512
		seen += 1
	}
	assert.ok(seen > Object.keys(files).length)
	assert.ok(tar.subarray(at).equals(Buffer.alloc(1024)), 'two zero blocks and nothing else')
})

test('a link in the folder cannot be packed, and a stray files.json is refused', async () => {
	const root = tempDir('kernel-src')
	writeTree(root, { 'a.txt': 'a' })
	const { symlinkSync } = await import('node:fs')
	symlinkSync('a.txt', join(root, 'link.txt'))
	await assert.rejects(buildFilesList(root), /not a regular file/)
	rmSync(join(root, 'link.txt'))
	writeTree(root, { 'files.json': '{}' })
	await assert.rejects(buildFilesList(root), /already has a files.json/)
})

// --- every refusal of 3.3, each from a deliberately broken archive ---------------------------------------

const FILES = { 'a.txt': 'alpha', 'b/c.txt': 'gamma' }
async function refused(parts, pattern, options = {}) {
	const dir = tempDir('kernel-bad')
	const path = join(dir, 'bad.tar.gz')
	writeFileSync(path, options.raw ?? archive(parts))
	await assert.rejects(readArchive(path, options.read), (error) => {
		assert.ok(error instanceof ArchiveRefusal, `not an ArchiveRefusal: ${error}`)
		assert.match(error.message, pattern)
		return true
	})
}

test('the good archive built by the test builder is read (so the refusals below mean something)', async () => {
	const dir = tempDir('kernel-good')
	writeFileSync(join(dir, 'good.tar.gz'), archive(goodParts(FILES)))
	const read = await readArchive(join(dir, 'good.tar.gz'), { limits: { fileCount: 2, unpackedSize: 10 } })
	assert.equal(read.files.size, 2)
})

for (const [label, type] of [
	['a symbolic link', '2'],
	['a hard link', '1'],
	['a directory', '5'],
	['a character device', '3'],
	['a global pax header', 'g'],
	['a GNU long name', 'L'],
	['a sparse entry', 'S'],
	['an old-style regular file (type NUL)', '\0'],
]) {
	test(`refused: ${label}`, async () => {
		const parts = goodParts(FILES)
		parts.splice(2, 0, tarEntry({ name: 'extra', type }))
		await refused(parts, /only regular files are allowed/)
	})
}

test('refused: a pax key other than path', async () => {
	const parts = goodParts(FILES)
	parts.splice(1, 0, paxEntry([['mtime', '1']]))
	await refused(parts, /pax key "mtime"/)
})

test('refused: a pax header beside a path (any extra key)', async () => {
	const parts = goodParts(FILES)
	parts.splice(2, 0, paxEntry([['path', 'a.txt'], ['uid', '5']]))
	await refused(parts, /pax key "uid"/)
})

const BAD_NAMES = [
	['/etc/passwd', 'an absolute path'],
	['C:/win/x', 'a drive letter'],
	['C:x', 'a drive letter'],
	['a\\b', 'a backslash'],
	['dir/file:stream', 'a colon'],
	['a//b', 'an empty segment'],
	['./a', 'a dot segment'],
	['a/./b', 'a dot segment'],
	['a/../b', 'a dot-dot segment'],
	['../b', 'a dot-dot segment'],
	['CON', 'a reserved name'],
	['con.txt', 'a reserved name with an extension'],
	['dir/NUL.x.y', 'a reserved name in a folder'],
	['Aux', 'a reserved name'],
	['COM1', 'a reserved name'],
	['lpt9.log', 'a reserved name'],
	['dir./file', 'a segment ending in a dot'],
	['trailing-space /file', 'a segment ending in a space'],
	['file.', 'a name ending in a dot'],
]
for (const [name, label] of BAD_NAMES) {
	test(`refused name (${label}): ${JSON.stringify(name)}`, async () => {
		assert.ok(refusalForName(name), 'the reader names a reason')
		// In the tar stream (files.json lists only fine names).
		const parts = goodParts(FILES)
		parts.splice(2, 0, tarEntry({ name: name.slice(0, 100), data: 'x' }))
		await refused(parts, /entry named/)
		// In files.json.
		const files = { 'ok.txt': 'ok' }
		const bad = [
			tarEntry({
				name: 'files.json',
				data: Buffer.from(`${JSON.stringify({ schema: 1, files: [{ path: name, size: 2, sha256: sha256('ok') }, { path: 'ok.txt', size: 2, sha256: sha256('ok') }].sort((x, y) => (x.path < y.path ? -1 : 1)) })}\n`),
			}),
			tarEntry({ name: 'ok.txt', data: files['ok.txt'] }),
			END,
		]
		await refused(bad, /files\.json lists/)
	})
}

test('names the reader accepts', () => {
	for (const name of ['a', 'dir/file.js', '.hidden', 'a/.b', 'node_modules/@scope/pkg/x.node', 'console.js', 'aux-file', 'comm1', 'a b/c']) assert.equal(refusalForName(name), undefined, name)
})

test('refused: a name given in a pax header is checked like any other', async () => {
	const parts = goodParts(FILES)
	parts.splice(2, 0, paxEntry([['path', '../escape']]), tarEntry({ name: 'short', data: 'x' }))
	await refused(parts, /entry named "..\/escape"/)
})

test('refused: two names equal after case folding (in the stream and in files.json)', async () => {
	const files = { 'File.txt': 'one', 'file.txt': 'two' }
	await refused(goodParts(files), /equal in lower case/)
	const parts = goodParts({ 'File.txt': 'one' })
	parts.splice(2, 0, tarEntry({ name: 'FILE.TXT', data: 'one' }))
	await refused(parts, /equal in lower case/)
})

test('refused: a file the list does not name', async () => {
	const parts = goodParts(FILES)
	parts.splice(3, 0, tarEntry({ name: 'extra.txt', data: 'x' }))
	await refused(parts, /does not list/)
})

test('refused: a listed file that is missing', async () => {
	const parts = goodParts(FILES)
	parts.splice(2, 1)
	await refused(parts, /does not have it/)
})

test('refused: a size that differs from files.json', async () => {
	const parts = goodParts(FILES)
	parts[1] = tarEntry({ name: 'a.txt', data: 'alphaX' })
	await refused(parts, /bytes in the archive and 5 in files\.json/)
})

test('refused: a sha256 that differs from files.json', async () => {
	const parts = goodParts(FILES)
	parts[1] = tarEntry({ name: 'a.txt', data: 'ALPHA' })
	await refused(parts, /does not match its sha256/)
})

test('refused: more files than the manifest states', async () => {
	await refused(goodParts(FILES), /allows 1/, { read: { limits: { fileCount: 1, unpackedSize: 1000 } } })
})

test('refused: more unpacked bytes than the manifest states', async () => {
	await refused(goodParts(FILES), /more than the 9 bytes/, { read: { limits: { fileCount: 2, unpackedSize: 9 } } })
})

test('refused: bytes after the end blocks', async () => {
	await refused([...goodParts(FILES), Buffer.from('trailing')], /bytes after its end blocks|two zero blocks/)
	await refused([...goodParts(FILES), tarEntry({ name: 'late.txt', data: 'x' })], /bytes after its end blocks/)
})

test('refused: fewer than two end blocks', async () => {
	const parts = goodParts(FILES)
	parts[parts.length - 1] = Buffer.alloc(512)
	await refused(parts, /truncated|two zero blocks/)
})

test('refused: truncated (gzip cut, and tar cut inside a file)', async () => {
	const whole = archive(goodParts(FILES))
	await refused([], /gzip over tar|truncated|zero blocks/, { raw: whole.subarray(0, whole.length - 30) })
	const tar = Buffer.concat(goodParts(FILES))
	await refused([], /truncated/, { raw: gzipSync(tar.subarray(0, 512 + 512 + 512 + 100)) })
})

test('refused: files.json is not first, missing, or not in the exact serialisation', async () => {
	const parts = goodParts(FILES)
	await refused([parts[1], parts[0], parts[2], END], /not files\.json/)
	await refused([parts[1], END], /not files\.json/)
	const pretty = Buffer.from(JSON.stringify(JSON.parse(listBytes(FILES).toString()), null, 2))
	await refused([tarEntry({ name: 'files.json', data: pretty }), parts[1], parts[2], END], /serialised/)
	await refused([tarEntry({ name: 'files.json', data: Buffer.from('{}\n') }), END], /shape/)
})

test('refused: files.json unsorted, listing itself, or with a bad hash', async () => {
	const a = { path: 'a.txt', size: 5, sha256: sha256('alpha') }
	const b = { path: 'b/c.txt', size: 5, sha256: sha256('gamma') }
	const listOf = (files) => tarEntry({ name: 'files.json', data: Buffer.from(`${JSON.stringify({ schema: 1, files })}\n`) })
	await refused([listOf([b, a]), END], /not sorted/)
	await refused([listOf([{ path: 'files.json', size: 1, sha256: sha256('x') }]), END], /lists itself/)
	await refused([listOf([{ ...a, sha256: 'xyz' }]), END], /bad sha256/)
	await refused([listOf([{ ...a, size: -1 }]), END], /bad size/)
})

test('refused: a bad checksum, a header that is not ustar, a name prefix, and bytes that are not gzip', async () => {
	const parts = goodParts(FILES)
	await refused([tarEntry({ name: 'files.json', data: listBytes(FILES), badSum: true }), parts[1], parts[2], END], /checksum/)
	await refused([tarEntry({ name: 'files.json', data: listBytes(FILES), magic: 'GNUtar' }), parts[1], parts[2], END], /not ustar/)
	await refused([tarEntry({ name: 'files.json', data: listBytes(FILES), prefix: 'x' }), parts[1], parts[2], END], /prefix/)
	await refused([], /gzip over tar/, { raw: Buffer.from('this is not an archive at all') })
})

test('a refusal never leaves the file open or half-written state behind (unpack removes its folder)', async () => {
	const { unpackArchive } = await import('../kernel/unpack.mjs')
	const dir = tempDir('kernel-unpack')
	const parts = goodParts(FILES)
	parts[1] = tarEntry({ name: 'a.txt', data: 'ALPHA' })
	writeFileSync(join(dir, 'bad.tar.gz'), archive(parts))
	await assert.rejects(unpackArchive({ archive: join(dir, 'bad.tar.gz'), out: join(dir, 'x') }), ArchiveRefusal)
	assert.equal((await import('node:fs')).existsSync(join(dir, 'x')), false)
})

test('filesJsonBytes is JSON.stringify plus one newline', () => {
	assert.equal(filesJsonBytes({ schema: 1, files: [] }).toString(), '{"schema":1,"files":[]}\n')
})
