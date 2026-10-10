import { describe, expect, it } from 'vitest'
import { displayPath, middleEllipsis, projectRelative, tildePath } from './path-display.js'

describe('projectRelative', () => {
	it('gives the part below the project folder, with forward slashes', () => {
		expect(projectRelative('/tmp/p/src/a.ts', '/tmp/p')).toBe('src/a.ts')
		expect(projectRelative('C:\\work\\p\\src\\a.ts', 'C:\\work\\p')).toBe('src/a.ts')
		expect(projectRelative('/tmp/p', '/tmp/p/')).toBe('.')
	})

	it('does not mistake a sibling that shares a prefix for a child', () => {
		expect(projectRelative('/tmp/p2/a.ts', '/tmp/p')).toBeUndefined()
	})

	it('ignores the case of a Windows drive path and nothing else', () => {
		expect(projectRelative('c:\\Work\\P\\a.ts', 'C:\\work\\p')).toBe('a.ts')
		expect(projectRelative('/tmp/P/a.ts', '/tmp/p')).toBeUndefined()
	})

	it('has nothing to say without a root', () => {
		expect(projectRelative('/tmp/p/a.ts')).toBeUndefined()
	})
})

describe('tildePath', () => {
	it('writes the home folder of any system as ~', () => {
		expect(tildePath('/home/arda/notes/a.md')).toBe('~/notes/a.md')
		expect(tildePath('/Users/arda/notes/a.md')).toBe('~/notes/a.md')
		expect(tildePath('C:\\Users\\arda\\notes\\a.md')).toBe('~/notes/a.md')
		expect(tildePath('/srv/data/a.md')).toBe('/srv/data/a.md')
	})
})

describe('middleEllipsis', () => {
	it('keeps both ends of a long path', () => {
		const long = '~/workspaces/clients/acme/projects/website/src/components/pricing/table.tsx'
		const cut = middleEllipsis(long, 40)
		expect(Array.from(cut)).toHaveLength(40)
		expect(cut.startsWith('~/workspaces')).toBe(true)
		expect(cut.endsWith('table.tsx')).toBe(true)
		expect(cut).toContain('…')
	})

	it('leaves a short path alone and never splits a letter', () => {
		expect(middleEllipsis('src/a.ts', 40)).toBe('src/a.ts')
		const turkish = 'projeler/müşteri/İstanbul/şubeler/çalışma/günlük/özet/ığdır/rapor-ğüşiöç.md'
		const cut = middleEllipsis(turkish, 30)
		expect(Array.from(cut)).toHaveLength(30)
		expect(cut).not.toContain('\ufffd')
		expect(cut.endsWith('rapor-ğüşiöç.md')).toBe(true)
	})
})

describe('displayPath', () => {
	it('prefers the project-relative spelling, then ~, then the cut path', () => {
		expect(displayPath('/tmp/p/new/deep/n.txt', '/tmp/p')).toBe('new/deep/n.txt')
		expect(displayPath('/home/arda/notes/a.md', '/tmp/p')).toBe('~/notes/a.md')
		expect(displayPath('/srv/data/a.md')).toBe('/srv/data/a.md')
	})
})
