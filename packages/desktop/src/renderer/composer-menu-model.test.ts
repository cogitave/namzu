import { describe, expect, it } from 'vitest'
import {
	type SlashEntry,
	activeMention,
	applyMention,
	argumentGhost,
	filterSlash,
	findSlash,
	mentionPieces,
	mentionText,
	menuKeyStep,
	mirrorParts,
	moveHighlight,
	pickSlash,
	renamedSlash,
	slashLine,
	slashQuery,
} from './composer-menu-model.js'

const row = (name: string, tooltip: string, extra: Partial<SlashEntry> = {}): SlashEntry => ({
	name,
	tooltip,
	...extra,
})

const rows: SlashEntry[] = [
	row('model', 'Choose the model for the next message'),
	row('effort', 'Choose how long the model thinks', { argHint: '[low, medium, high]' }),
	row('code-review', 'Look at the changes with a clear effort'),
	row('config', 'Open Settings', { aliases: ['settings'] }),
	row('diff', 'Show or hide the changes'),
	row('simplify', 'Tidy the code for efficiency'),
]

describe('slashQuery', () => {
	it('opens only for a leading slash with no space before the caret', () => {
		expect(slashQuery('/', 1)).toBe('')
		expect(slashQuery('/ef', 3)).toBe('ef')
		expect(slashQuery('/ef', 2)).toBe('e')
		expect(slashQuery('/effort high', 12)).toBeNull()
		expect(slashQuery('/effort high', 3)).toBe('ef')
		expect(slashQuery('hello /x', 8)).toBeNull()
		expect(slashQuery('', 0)).toBeNull()
	})
})

describe('filterSlash', () => {
	it('lists every row for an empty query, in the table order', () => {
		expect(filterSlash(rows, '').map((r) => r.name)).toEqual(rows.map((r) => r.name))
	})

	it('puts names that start with the text first, then description matches, each in table order', () => {
		expect(filterSlash(rows, 'ef').map((r) => r.name)).toEqual([
			'effort',
			'code-review',
			'simplify',
		])
	})

	it('ranks an exact name, then a prefix, then a name that contains it', () => {
		const list = [row('refile', 'x'), row('file', 'x'), row('files', 'x')]
		expect(filterSlash(list, 'file').map((r) => r.name)).toEqual(['file', 'files', 'refile'])
	})

	it('matches an alias, ignores case and accents, and drops what does not match', () => {
		expect(filterSlash(rows, 'SETT').map((r) => r.name)).toEqual(['config'])
		expect(filterSlash(rows, 'İFF').map((r) => r.name)).toEqual(['diff'])
		expect(filterSlash(rows, 'efzz')).toEqual([])
	})
})

describe('picking', () => {
	it('leaves "/name " for a row that takes text and runs any other at once', () => {
		expect(pickSlash(rows[1] as SlashEntry)).toEqual({ text: '/effort ', run: false })
		expect(pickSlash(rows[4] as SlashEntry)).toEqual({ text: '', run: true })
	})

	it('finds the row a typed line names, with its argument', () => {
		expect(slashLine(rows, '/effort high')?.argument).toBe('high')
		expect(slashLine(rows, '/effort')?.argument).toBe('')
		expect(slashLine(rows, '/settings')?.entry.name).toBe('config')
		expect(slashLine(rows, '/usr/bin/foo is missing')).toBeNull()
		expect(slashLine(rows, '/diff the other branch')).toBeNull()
		expect(slashLine(rows, '/diff')?.entry.name).toBe('diff')
		expect(slashLine(rows, 'plain')).toBeNull()
		expect(findSlash(rows, 'effortx')).toBeUndefined()
	})

	it('finds a command spelled as two words, and names the new spelling for the old hyphen form', () => {
		const spelled = [row('release notes', 'x'), ...rows]
		expect(slashLine(spelled, '/release notes')?.entry.name).toBe('release notes')
		expect(slashLine(spelled, '/release-notes')).toBeNull()
		expect(renamedSlash('/release-notes')).toBe('This command is now /release notes.')
		expect(renamedSlash('/release notes')).toBeNull()
		expect(renamedSlash('/effort')).toBeNull()
	})
})

describe('the argument hint', () => {
	it('shows after "/name " and goes at the first typed character', () => {
		expect(argumentGhost(rows, '/effort ')).toBe('[low, medium, high]')
		expect(argumentGhost(rows, '/effort h')).toBeUndefined()
		expect(argumentGhost(rows, '/effort')).toBeUndefined()
		expect(argumentGhost(rows, '/diff ')).toBeUndefined()
		expect(argumentGhost(rows, '/nope ')).toBeUndefined()
	})

	it('is painted by the mirror only for a listed command', () => {
		expect(mirrorParts(rows, '/effort ', false)).toEqual({
			command: '/effort',
			rest: ' ',
			ghost: '[low, medium, high]',
		})
		expect(mirrorParts(rows, '/effort high', false)).toEqual({ command: '/effort', rest: ' high' })
		expect(mirrorParts(rows, '/ef', true)).toBeNull()
		expect(mirrorParts(rows, '/', true)).toEqual({
			command: '/',
			rest: '',
			ghost: 'Type to filter',
		})
		expect(mirrorParts(rows, '/', false)).toBeNull()
		expect(mirrorParts(rows, 'hello', true)).toBeNull()
	})
})

describe('keys and the highlight', () => {
	it('gives the open menu its keys and leaves chords to the box', () => {
		const plain = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
		expect(menuKeyStep('ArrowDown', plain)).toBe('down')
		expect(menuKeyStep('Enter', plain)).toBe('pick')
		expect(menuKeyStep('Tab', plain)).toBe('pick')
		expect(menuKeyStep('Escape', plain)).toBe('close')
		expect(menuKeyStep('Enter', { ...plain, ctrlKey: true })).toBeNull()
		expect(menuKeyStep('Enter', { ...plain, shiftKey: true })).toBeNull()
		expect(menuKeyStep('a', plain)).toBeNull()
	})

	it('stops at the ends and moves a page by seven rows', () => {
		expect(moveHighlight(0, 'up', 5)).toBe(0)
		expect(moveHighlight(4, 'down', 5)).toBe(4)
		expect(moveHighlight(1, 'down', 5)).toBe(2)
		expect(moveHighlight(1, 'page-down', 20)).toBe(8)
		expect(moveHighlight(3, 'page-up', 20)).toBe(0)
		expect(moveHighlight(0, 'down', 0)).toBe(0)
	})
})

describe('@ mentions', () => {
	it('opens at the start or after white space and runs to the caret', () => {
		expect(activeMention('@ind', 4)).toEqual({ start: 0, query: 'ind', quoted: false })
		expect(activeMention('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a', quoted: false })
		expect(activeMention('look at @', 9)).toEqual({ start: 8, query: '', quoted: false })
		expect(activeMention('line\n@x', 7)).toEqual({ start: 5, query: 'x', quoted: false })
	})

	it('does not open inside an address, after a space in the name, or past a closed token', () => {
		expect(activeMention('me@example.com', 14)).toBeNull()
		expect(activeMention('@a b', 4)).toBeNull()
		expect(activeMention('@a ', 3)).toBeNull()
		expect(activeMention('no at here', 10)).toBeNull()
	})

	it('allows spaces inside a quoted name', () => {
		expect(activeMention('@"my fi', 7)).toEqual({ start: 0, query: 'my fi', quoted: true })
		expect(activeMention('@"my file.txt" more', 19)).toBeNull()
	})

	it('writes a path, quoting one with spaces, and keeps the text around it', () => {
		expect(mentionText('src/a.ts')).toBe('@src/a.ts ')
		expect(mentionText('my docs/a b.txt')).toBe('@"my docs/a b.txt" ')
		const value = 'read @sr please'
		const mention = activeMention(value, 8)
		expect(mention).not.toBeNull()
		expect(applyMention(value, 8, mention as never, 'src/a.ts')).toEqual({
			value: 'read @src/a.ts please',
			caret: 15,
		})
		const end = activeMention('@i', 2)
		expect(applyMention('@i', 2, end as never, 'index.html')).toEqual({
			value: '@index.html ',
			caret: 12,
		})
	})
})

describe('picked @ files in the mirror', () => {
	it('marks only a picked token that stands whole', () => {
		expect(mentionPieces('look at @src/app.ts now', ['@src/app.ts'])).toEqual([
			{ text: 'look at ', mention: false },
			{ text: '@src/app.ts', mention: true },
			{ text: ' now', mention: false },
		])
		expect(mentionPieces('@a.ts', ['@a.ts'])).toEqual([{ text: '@a.ts', mention: true }])
		expect(mentionPieces('see @a.tsx', ['@a.ts'])).toEqual([{ text: 'see @a.tsx', mention: false }])
		expect(mentionPieces('x@a.ts', ['@a.ts'])).toEqual([{ text: 'x@a.ts', mention: false }])
		expect(mentionPieces('nothing', [])).toEqual([{ text: 'nothing', mention: false }])
		expect(mentionPieces('', ['@a.ts'])).toEqual([])
	})

	it('knows a name with spaces', () => {
		expect(mentionPieces('open @"my file.ts" please', ['@"my file.ts"'])).toEqual([
			{ text: 'open ', mention: false },
			{ text: '@"my file.ts"', mention: true },
			{ text: ' please', mention: false },
		])
	})
})
