import { describe, expect, it } from 'vitest'
import {
	FilesListError,
	findCollision,
	foldName,
	parseFilesList,
	refuseName,
} from './files-list.js'
import { filesJsonOf } from './kernel-test-support.js'

describe('names in a file list', () => {
	it('says which rule a drive letter broke, not only that it was refused', () => {
		expect(refuseName('C:evil')).toBe('a drive letter')
		expect(refuseName('C:/evil')).toBe('a drive letter')
		expect(refuseName('a:b')).toBe('a drive letter')
		expect(refuseName('dir/a:b')).toBe('a colon in a name')
	})

	it.each([
		'CON',
		'con.txt',
		'dir/NUL.log',
		'COM1',
		'com\u00b9',
		'LPT\u00b2.txt',
		'CONIN$',
		'conout$',
		'CLOCK$',
		'con .txt',
		'a/aux  .js',
	])('refuses the reserved device name %s', (name) => {
		expect(refuseName(name)).toBe('a reserved device name')
	})

	it.each(['a<b', 'a>b', 'a|b', 'a?b', 'a*b', 'a"b'])(
		'refuses %s, which a Windows file cannot hold',
		(name) => {
			expect(refuseName(name)).toMatch(/Windows file name/u)
		},
	)

	it('allows ordinary names, including ones that only contain a device name', () => {
		for (const name of ['dist/bin.js', 'console.js', 'dist/conf/x.json', 'com10.txt', 'a b/c d.js'])
			expect(refuseName(name), name).toBeUndefined()
	})

	it('folds case the way a case-insensitive disk does', () => {
		// Lower-casing alone keeps a final sigma apart from the other one; upper then lower does not.
		expect(foldName('a\u03c2')).toBe(foldName('a\u03c3'))
		expect(findCollision(['a\u03c2', 'a\u03c3'])).toMatch(/case folding/u)
		expect(findCollision(['a/B.js', 'a/b.js'])).toMatch(/one after case folding/u)
	})

	it('treats a name that folds to files.json as files.json, which sits beside the list', () => {
		expect(findCollision(['FILES.JSON'])).toMatch(/case folding/u)
		const bytes = filesJsonOf({ 'FILES.JSON': 'x' })
		expect(() => parseFilesList(bytes)).toThrow(FilesListError)
	})
})
