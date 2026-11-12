// Shared by the kernel publisher tests. The tar builder here is the TEST's own, written separately from
// scripts/kernel/archive-writer.mjs, so a deliberately broken archive is made without the code under test.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const tempDir = (label = 'kernel-test') => mkdtempSync(join(tmpdir(), `namzu-${label}-`))
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** Write `{ 'a/b.txt': 'text' }` under a folder. */
export function writeTree(root, files) {
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), data)
	}
}

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

/** One tar entry. `type`, `size`, `prefix`, `badSum` and `magic` can be bent on purpose. */
export function tarEntry({ name, data = Buffer.alloc(0), type = '0', size, prefix, badSum = false, magic = 'ustar\0' }) {
	const body = Buffer.from(data)
	const block = Buffer.alloc(512)
	block.write(name, 0, 'utf8')
	block.write(octal(0o644, 8), 100, 'latin1')
	block.write(octal(0, 8), 108, 'latin1')
	block.write(octal(0, 8), 116, 'latin1')
	block.write(octal(size ?? body.length, 12), 124, 'latin1')
	block.write(octal(0, 12), 136, 'latin1')
	block.fill(0x20, 148, 156)
	block.write(type, 156, 'latin1')
	block.write(magic, 257, 'latin1')
	block.write('00', 263, 'latin1')
	if (prefix) block.write(prefix, 345, 'latin1')
	let sum = 0
	for (const byte of block) sum += byte
	block.write(`${(badSum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
	return Buffer.concat([block, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

export function paxEntry(records) {
	const text = records
		.map(([key, value]) => {
			const rest = ` ${key}=${value}\n`
			let length = Buffer.byteLength(rest)
			while (Buffer.byteLength(`${length}${rest}`) !== length) length = Buffer.byteLength(`${length}${rest}`)
			return `${length}${rest}`
		})
		.join('')
	return tarEntry({ name: 'PaxHeader', type: 'x', data: Buffer.from(text) })
}

export const END = Buffer.alloc(1024)

/** The list file for `{ path: data }` in the exact serialisation the text asks for. */
export function listBytes(files, overrides = {}) {
	const entries = Object.keys(files)
		.sort()
		.map((path) => ({ path, size: Buffer.byteLength(files[path]), sha256: sha256(files[path]) }))
	return Buffer.from(`${JSON.stringify({ schema: 1, files: entries, ...overrides })}\n`)
}

/**
 * A good archive for `files`, as parts: [list entry, ...file entries, END]. Tests replace or add parts
 * and join them with `archive(parts)`.
 */
export function goodParts(files) {
	return [
		tarEntry({ name: 'files.json', data: listBytes(files) }),
		...Object.keys(files)
			.sort()
			.map((name) => tarEntry({ name, data: files[name] })),
		END,
	]
}

export function archive(parts, { gzip = true } = {}) {
	const tar = Buffer.concat(parts)
	return gzip ? gzipSync(tar) : tar
}

/** A folder that looks like a kernel: kernel.json, package.json and a few files. */
export function smallKernelFiles(extra = {}) {
	return {
		'kernel.json': `${JSON.stringify({ schema: 1, commandLine: '1.2.3', engine: '4.5.6', desktopContract: 1, dataEpoch: 1, platform: 'win32', arch: 'x64' })}\n`,
		'package.json': '{"name":"@namzu/cli","version":"1.2.3"}\n',
		'dist/bin.js': 'console.log("hi")\n',
		'dist/empty.txt': '',
		'node_modules/pkg/index.js': 'module.exports = 1\n',
		[`node_modules/${'deep-'.repeat(25)}package/a-file-with-a-long-name-to-need-a-pax-header.js`]: '// long\n',
		'skills/ünïcode.md': '# unicode name\n',
		...extra,
	}
}
