import { describe, expect, it } from 'vitest'
import { displayPath } from './display-path.js'

describe('a path as a person reads it', () => {
	const cwd = '/home/me/work/app'
	const home = '/home/me'

	it('keeps a relative path inside the folder as the model gave it', () => {
		expect(displayPath('src/a.ts', cwd, home)).toBe('src/a.ts')
	})

	it('shows an absolute path inside the folder relative to it', () => {
		expect(displayPath('/home/me/work/app/src/a.ts', cwd, home)).toBe('src/a.ts')
	})

	it('never shows ../../x: under home it is ~/x', () => {
		expect(displayPath('../../notes/x.md', cwd, home)).toBe('~/notes/x.md')
		expect(displayPath('/home/me/notes/x.md', cwd, home)).toBe('~/notes/x.md')
	})

	it('shows the full path when the file is outside home too', () => {
		expect(displayPath('../../../../etc/hosts', cwd, home)).toBe('/etc/hosts')
		expect(displayPath('/tmp/scratch/x.txt', cwd, home)).toBe('/tmp/scratch/x.txt')
	})

	it('leaves an address alone', () => {
		expect(displayPath('https://example.com/a', cwd, home)).toBe('https://example.com/a')
	})
})
