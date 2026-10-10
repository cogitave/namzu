import { expect, it } from 'vitest'
import { formatSize, shortFileName } from './format-size.js'

it('writes sizes in one style', () => {
	expect(formatSize(0)).toBe('0 B')
	expect(formatSize(512)).toBe('512 B')
	expect(formatSize(12 * 1024)).toBe('12 KB')
	expect(formatSize(1024 + 1)).toBe('2 KB')
	expect(formatSize(3 * 1024 * 1024)).toBe('3 MB')
	expect(formatSize(1.2 * 1024 * 1024)).toBe('1.2 MB')
	expect(formatSize(286.1 * 1024 * 1024)).toBe('287 MB')
	expect(formatSize(2.5 * 1024 ** 3)).toBe('2.5 GB')
	expect(formatSize(Number.NaN)).toBe('0 B')
})

it('keeps the start and the extension of a long file name', () => {
	expect(shortFileName('notes.txt')).toBe('notes.txt')
	const long = `${'a'.repeat(60)}.pdf`
	const short = shortFileName(long)
	expect(Array.from(short).length).toBeLessThanOrEqual(40)
	expect(short).toMatch(/^a+….*\.pdf$/)
})
