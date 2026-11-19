import { describe, expect, it } from 'vitest'
import {
	addFolder,
	missingFolders,
	skillSwitchRows,
	skillsDisabledValue,
	withoutItem,
} from './config-lists-values.js'

describe('the folder list', () => {
	it('adds a picked folder once, trimmed, and ignores an empty pick', () => {
		expect(addFolder(['/a'], ' /b ')).toEqual(['/a', '/b'])
		expect(addFolder(['/a'], '/a')).toEqual(['/a'])
		expect(addFolder(['/a'], '  ')).toEqual(['/a'])
		expect(addFolder([], '/a')).toEqual(['/a'])
	})
	it('removes one entry and keeps the order of the rest', () => {
		expect(withoutItem(['/a', '/b', '/c'], '/b')).toEqual(['/a', '/c'])
		expect(withoutItem(['/a'], '/a')).toEqual([])
	})
	it('calls nothing missing until the check has answered', () => {
		expect(missingFolders(['/a', '/b'], undefined).size).toBe(0)
		expect([...missingFolders(['/a', '/b'], ['/a'])]).toEqual(['/b'])
		expect(missingFolders(['/a'], ['/a']).size).toBe(0)
	})
})

describe('the skills switches', () => {
	const installed = [
		{ name: 'review', where: 'built-in' },
		{ name: 'mine', where: '~/.namzu/skills' },
	]
	it('lists every installed skill as on unless its name is in the file', () => {
		expect(skillSwitchRows(installed, ['mine'])).toEqual({
			installed: [
				{ name: 'review', where: 'built-in', on: true },
				{ name: 'mine', where: '~/.namzu/skills', on: false },
			],
			unknown: [],
		})
	})
	it('keeps a name no installed skill has, once, in the order of the file', () => {
		expect(skillSwitchRows(installed, ['gone', 'mine', 'gone', 'other']).unknown).toEqual([
			'gone',
			'other',
		])
		expect(skillSwitchRows(installed, undefined).unknown).toEqual([])
		expect(skillSwitchRows(installed, 'x').installed.every((s) => s.on)).toBe(true)
	})
	it('turning a skill off adds its name and on takes it out', () => {
		expect(skillsDisabledValue(undefined, 'a', false)).toEqual(['a'])
		expect(skillsDisabledValue(['a'], 'b', false)).toEqual(['a', 'b'])
		expect(skillsDisabledValue(['a'], 'a', false)).toEqual(['a'])
		expect(skillsDisabledValue(['a', 'b'], 'a', true)).toEqual(['b'])
	})
	it('writes nothing for an empty list, so the key is removed', () => {
		expect(skillsDisabledValue(['a'], 'a', true)).toBeUndefined()
		expect(skillsDisabledValue(undefined, 'a', true)).toBeUndefined()
	})
	it('leaves a name the file holds that no skill has when another switch moves', () => {
		expect(skillsDisabledValue(['gone'], 'review', false)).toEqual(['gone', 'review'])
	})
})

describe('one folder spelled two ways', () => {
	it('does not add a folder that differs only by a trailing separator', () => {
		expect(addFolder(['/home/u/x'], '/home/u/x/')).toEqual(['/home/u/x'])
		expect(addFolder(['/home/u/x/'], '/home/u/x')).toEqual(['/home/u/x/'])
		expect(addFolder([], '/home/u/x/')).toEqual(['/home/u/x'])
		expect(addFolder([], '/')).toEqual(['/'])
	})
})
