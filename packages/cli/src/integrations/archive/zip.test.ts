import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeZip } from '../extensions/__fixtures__/package-builder.js'
import { ArchiveError, type ArchiveLimits, listEntries, openArchive } from './zip.js'

const LIMITS: ArchiveLimits = {
	maxEntries: 10,
	maxUnpackedBytes: 1024 * 1024,
	maxRatio: 100,
	allowExecutable: true,
	subject: 'skill',
}

const x = Buffer.from('x')
const open = (entries: Parameters<typeof makeZip>[0], limits: Partial<ArchiveLimits> = {}) =>
	openArchive(makeZip(entries), { ...LIMITS, ...limits })
const check = (fn: () => unknown): string => {
	try {
		fn()
	} catch (err) {
		if (err instanceof ArchiveError) return err.check
		throw err
	}
	return 'none'
}
const message = (fn: () => unknown): string => {
	try {
		fn()
	} catch (err) {
		return (err as Error).message
	}
	return ''
}

describe('openArchive', () => {
	it('reads files, drops directories and reports the execute bit', () => {
		const files = open([
			{ name: 'dir/', data: Buffer.alloc(0), mode: 0o040755 },
			{ name: 'a.txt', data: Buffer.from('hello') },
			{ name: 'run.sh', data: Buffer.from('#!/bin/sh'), mode: 0o100755, store: true },
		])
		expect([...files.keys()]).toEqual(['a.txt', 'run.sh'])
		expect(files.get('a.txt')?.bytes.toString()).toBe('hello')
		expect(files.get('a.txt')?.executable).toBe(false)
		expect(files.get('run.sh')?.executable).toBe(true)
	})

	it('names the archive by the caller subject', () => {
		expect(message(() => openArchive(Buffer.from('short'), LIMITS))).toBe(
			'This is not a skill file (too short).',
		)
		expect(message(() => openArchive(Buffer.alloc(64), { ...LIMITS, subject: undefined }))).toBe(
			'This is not a archive file (no zip directory).',
		)
	})

	it('refuses a ratio above the limit and accepts one at it', () => {
		const bomb = Buffer.alloc(200_000)
		expect(check(() => open([{ name: 'bomb.bin', data: bomb }]))).toBe('zip-bomb')
		const ratio = bomb.length / deflateRawSync(bomb).length
		expect(() =>
			open([{ name: 'bomb.bin', data: bomb }], { maxRatio: Math.ceil(ratio) }),
		).not.toThrow()
	})

	it('refuses a total above maxUnpackedBytes, counting every entry', () => {
		const half = Buffer.from('abcdefgh'.repeat(40)) // 320 bytes, low ratio
		const two = [
			{ name: 'a', data: half, store: true },
			{ name: 'b', data: half, store: true },
		]
		expect(() => open(two, { maxUnpackedBytes: 640 })).not.toThrow()
		expect(check(() => open(two, { maxUnpackedBytes: 639 }))).toBe('zip-size')
	})

	it('refuses more entries than maxEntries', () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: x }))
		expect(() => open(many(3), { maxEntries: 3 })).not.toThrow()
		expect(check(() => open(many(4), { maxEntries: 3 }))).toBe('zip-entries')
		expect(message(() => open(many(4), { maxEntries: 3 }))).toBe(
			'The skill has 4 entries; at most 3 are accepted.',
		)
	})

	it('refuses a path that climbs out', () => {
		expect(check(() => open([{ name: '../evil', data: x }]))).toBe('zip-slip')
		expect(check(() => open([{ name: 'a/../../evil', data: x }]))).toBe('zip-slip')
		expect(message(() => open([{ name: '../evil', data: x }]))).toBe(
			'An entry climbs out of the skill folder: ../evil.',
		)
	})

	it('refuses absolute paths', () => {
		for (const name of ['/etc/passwd', '\\share\\x', 'C:/x', 'c:x'])
			expect(check(() => open([{ name, data: x }]))).toBe('zip-name')
	})

	it('refuses a backslash in a name', () => {
		expect(check(() => open([{ name: 'a\\b.txt', data: x }]))).toBe('zip-name')
	})

	it('refuses control characters', () => {
		for (const name of ['a\u0000b', 'a\nb', 'a\u007fb'])
			expect(check(() => open([{ name, data: x }]))).toBe('zip-name')
	})

	it('refuses duplicate names and names that differ only by case', () => {
		expect(
			check(() =>
				open([
					{ name: 'a.txt', data: x },
					{ name: 'a.txt', data: x },
				]),
			),
		).toBe('zip-duplicate')
		expect(
			check(() =>
				open([
					{ name: 'a.txt', data: x },
					{ name: 'A.TXT', data: x },
				]),
			),
		).toBe('zip-case')
	})

	it('refuses links and devices, and accepts regular files and directories', () => {
		expect(check(() => open([{ name: 'l', data: Buffer.from('/etc'), mode: 0o120777 }]))).toBe(
			'zip-link',
		)
		expect(check(() => open([{ name: 'd', data: Buffer.alloc(0), mode: 0o020666 }]))).toBe(
			'zip-link',
		)
		expect(check(() => open([{ name: 'f', data: x, mode: 0o100644 }]))).toBe('none')
	})

	it('refuses an execute bit only when allowExecutable is false', () => {
		const run = [{ name: 'run.sh', data: x, mode: 0o100755 }]
		expect(() => open(run)).not.toThrow()
		expect(check(() => open(run, { allowExecutable: false }))).toBe('zip-executable')
		expect(() => open([{ name: 'a', data: x }], { allowExecutable: false })).not.toThrow()
	})

	it('refuses an encrypted entry', () => {
		const zip = makeZip([{ name: 'a', data: x }])
		const dir = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
		zip.writeUInt16LE(1, dir + 8)
		expect(check(() => listEntries(zip, LIMITS))).toBe('zip-encrypted')
	})

	it('refuses zip64 markers in the end record and in an entry', () => {
		const eocd = (z: Buffer) => z.length - 22
		const a = makeZip([{ name: 'a', data: x }])
		a.writeUInt16LE(0xffff, eocd(a) + 10)
		expect(check(() => listEntries(a, LIMITS))).toBe('zip')
		expect(message(() => listEntries(a, LIMITS))).toBe('Zip64 archives are not accepted.')
		const b = makeZip([{ name: 'a', data: x }])
		b.writeUInt32LE(0xffffffff, b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24)
		expect(message(() => listEntries(b, LIMITS))).toBe('a is a zip64 entry.')
	})

	it('refuses an unsupported compression method', () => {
		const zip = makeZip([{ name: 'a', data: x }])
		zip.writeUInt16LE(12, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10)
		expect(message(() => openArchive(zip, LIMITS))).toBe(
			'a uses compression method 12, which is not accepted.',
		)
	})

	it('refuses an entry that does not inflate to its declared size', () => {
		const lie = makeZip([{ name: 'x', data: Buffer.from('hello world'), claimSize: 5 }])
		expect(check(() => openArchive(lie, LIMITS))).toBe('zip-bomb')
	})

	it('refuses multi-disk archives and a truncated directory', () => {
		const a = makeZip([{ name: 'a', data: x }])
		a.writeUInt16LE(1, a.length - 22 + 4)
		expect(message(() => listEntries(a, LIMITS))).toBe('Multi-disk archives are not accepted.')
		const b = makeZip([{ name: 'a', data: x }])
		b.writeUInt32LE(b.length, b.length - 22 + 16)
		expect(message(() => listEntries(b, LIMITS))).toBe('The zip directory is truncated.')
	})
})

describe('whole-MiB size message', () => {
	it('states the limit in MiB', () => {
		const big = Buffer.alloc(1024 * 1024 + 1, 7)
		expect(message(() => open([{ name: 'big', data: big, store: true }], { maxRatio: 1000 }))).toBe(
			'The skill unpacks to more than 1 MiB.',
		)
	})
})
