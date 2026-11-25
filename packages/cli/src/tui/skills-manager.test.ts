import { describe, expect, it } from 'vitest'

import type { SkillInfo } from '../skills/store.js'
import {
	type ManagerState,
	closingLine,
	layoutRow,
	manage,
	metaParts,
	nameColumn,
	openManager,
	pendingChanges,
	selectedIndex,
	subtitle,
	visibleRows,
} from './skills-manager.js'
import { choiceDisplayWidth } from './terminal-choice-text.js'

const info = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({
	name,
	description: `does ${name} and a good deal more besides`,
	path: `/x/${name}/SKILL.md`,
	source: 'project',
	tier: 'project',
	...extra,
})

const SPACE = { input: ' ' }
const press = (state: ManagerState, ...keys: Parameters<typeof manage>[1][]): ManagerState =>
	keys.reduce((s, key) => manage(s, key).state, state)

const open = (...skills: SkillInfo[]) => openManager(skills, undefined)
const stateOf = (s: ManagerState, name: string) => s.rows.find((r) => r.name === name)?.state

describe('the cycle', () => {
	it('moves the selected skill on, name-only, user-only, off, on', () => {
		let s = open(info('alpha'), info('beta'))
		const seen = [stateOf(s, 'alpha')]
		for (let i = 0; i < 4; i++) {
			s = press(s, SPACE)
			seen.push(stateOf(s, 'alpha'))
		}
		expect(seen).toEqual(['on', 'name-only', 'user-only', 'off', 'on'])
		expect(stateOf(s, 'beta')).toBe('on')
	})

	it('Enter cycles too, and a locked row does not move', () => {
		let s = open(info('alpha'), info('broken', { problem: 'the frontmatter does not parse' }))
		s = press(s, { input: '', return: true })
		expect(stateOf(s, 'alpha')).toBe('name-only')
		s = press(s, { input: '', down: true }, SPACE)
		expect(s.selected).toBe('broken')
		expect(stateOf(s, 'broken')).toBe('on')
	})

	it('a full round leaves nothing to save', () => {
		let s = open(info('alpha'))
		s = press(s, SPACE, SPACE, SPACE, SPACE)
		expect(pendingChanges(s)).toEqual({})
	})
})

describe('what would be saved', () => {
	it('names the new state, and null when it is what the layers below give', () => {
		const skills = [
			info('alpha'),
			info('beta', { disabled: true, problem: 'disabled by skills.disabled in the config' }),
		]
		let s = openManager(skills, ['beta'])
		expect(stateOf(s, 'beta')).toBe('off')
		s = press(s, SPACE)
		expect(pendingChanges(s)).toEqual({ alpha: 'name-only' })
		s = press(s, { input: '', down: true }, SPACE)
		// beta goes off -> on: the list says off, so an explicit "on" is what is saved.
		expect(pendingChanges(s)).toEqual({ alpha: 'name-only', beta: 'on' })
	})

	it('removes the key when a skill is put back where the list has it', () => {
		const s0 = openManager([info('alpha', { state: 'name-only' })], undefined)
		// name-only -> user-only -> off -> on, with nothing in the list: back at the base.
		const s = press(s0, SPACE, SPACE, SPACE)
		expect(stateOf(s, 'alpha')).toBe('on')
		expect(pendingChanges(s)).toEqual({ alpha: null })
	})
})

describe('what the layers below give', () => {
	it('uses a lower layer override as the base, so landing on it removes the key', () => {
		const s0 = openManager([info('alpha', { state: 'user-only' })], undefined, {
			alpha: 'user-only',
		})
		// Merged says user-only (from a lower layer); cycle to on, then round to user-only.
		const s1 = press(s0, SPACE)
		expect(stateOf(s1, 'alpha')).toBe('off')
		expect(pendingChanges(s1)).toEqual({ alpha: 'off' })
		const s2 = press(s0, SPACE, SPACE)
		expect(stateOf(s2, 'alpha')).toBe('on')
		expect(pendingChanges(s2)).toEqual({ alpha: 'on' })
	})

	it('always writes a state for a name the local file itself sets', () => {
		const s0 = openManager(
			[info('alpha', { state: 'user-only' })],
			undefined,
			{ alpha: 'user-only' },
			new Set(['alpha']),
		)
		const s = press(s0, SPACE, SPACE)
		expect(stateOf(s, 'alpha')).toBe('on')
		expect(pendingChanges(s)).toEqual({ alpha: 'on' })
	})
})

describe('the closing row', () => {
	it('says No changes, how many were updated, or why it could not save', () => {
		expect(closingLine(0, undefined)).toEqual({ text: 'No changes', failed: false })
		expect(closingLine(1, undefined).text).toBe('Updated 1 skill in this project')
		expect(closingLine(3, undefined).text).toBe('Updated 3 skills in this project')
		expect(closingLine(0, 'the file is read-only')).toEqual({
			text: "Couldn't save skill settings: the file is read-only",
			failed: true,
		})
	})

	it('Esc on the list closes; Esc in the search box only leaves the box', () => {
		let s = open(info('alpha'))
		expect(manage(s, { input: '', escape: true }).close).toBe(true)
		s = press(s, { input: '/' }, { input: 'a' })
		const first = manage(s, { input: '', escape: true })
		expect(first.close).toBe(false)
		expect(first.state.searching).toBe(false)
		expect(first.state.query).toBe('')
	})
})

describe('search', () => {
	const skills = [
		info('review', { description: 'reads a diff' }),
		info('deploy', { description: 'ships the build', tier: 'user', source: 'user' }),
		info('notes', { description: 'keeps notes', tier: 'system', source: 'system' }),
	]

	it('/ focuses the box, and typing narrows by name, description or place', () => {
		let s = open(...skills)
		s = press(s, { input: '/' })
		expect(s.searching).toBe(true)
		s = press(s, { input: 'd' }, { input: 'i' }, { input: 'f' }, { input: 'f' })
		expect(visibleRows(s).map((r) => r.name)).toEqual(['review'])
		expect(subtitle(s)).toBe('1 of 3 skills')
		s = press(
			s,
			{ input: '', escape: true },
			{ input: '/' },
			{ input: 's' },
			{ input: 'h' },
			{ input: 'i' },
			{ input: 'p' },
		)
		expect(visibleRows(s).map((r) => r.name)).toEqual(['deploy'])
		s = press(
			s,
			{ input: '', escape: true },
			{ input: '/' },
			...'built-in'.split('').map((input) => ({ input })),
		)
		expect(visibleRows(s).map((r) => r.name)).toEqual(['notes'])
	})

	it('Space and t are typed while searching, not read as commands', () => {
		let s = open(...skills)
		s = press(s, { input: '/' }, { input: 't' }, { input: ' ' })
		expect(s.sort).toBe('default')
		expect(s.query).toBe('t ')
		expect(stateOf(s, 'review')).toBe('on')
	})

	it('Backspace erases, Enter keeps the text and gives the keys back', () => {
		let s = open(...skills)
		s = press(s, { input: '/' }, { input: 'x' }, { input: 'y' }, { input: '', backspace: true })
		expect(s.query).toBe('x')
		s = press(s, { input: '', return: true })
		expect(s.searching).toBe(false)
		expect(s.query).toBe('x')
	})

	it('moves the cursor to the first match', () => {
		let s = open(...skills)
		s = press(s, { input: '', down: true }, { input: '/' }, { input: 'n' }, { input: 'o' })
		expect(s.selected).toBe('notes')
		expect(selectedIndex(s)).toBe(0)
	})
})

describe('sort', () => {
	it('t sorts by listing cost, largest first, and says so', () => {
		const skills = [
			info('a-small', { description: 'x' }),
			info('b-large', { description: 'y'.repeat(900) }),
			info('c-medium', { description: 'z'.repeat(400) }),
		]
		let s = open(...skills)
		expect(visibleRows(s).map((r) => r.name)).toEqual(['a-small', 'b-large', 'c-medium'])
		expect(subtitle(s)).toBe('3 skills')
		s = press(s, { input: 't' })
		expect(visibleRows(s).map((r) => r.name)).toEqual(['b-large', 'c-medium', 'a-small'])
		expect(subtitle(s)).toBe('3 skills · sorted by tokens')
		s = press(s, { input: 't' })
		expect(s.sort).toBe('default')
	})
})

describe('a row in a narrow terminal', () => {
	const row = (name: string, place: string) =>
		openManager([info(name, { description: 'd'.repeat(300) })], undefined).rows.map((r) => ({
			...r,
			place,
			state: 'name-only' as const,
		}))[0]!

	const longName = 'a-skill-with-quite-a-long-name-indeed-so-long'

	it.each([120, 80, 60, 40])('never takes more than %d cells', (width) => {
		for (const selected of [true, false]) {
			const r = row(longName, 'project, shared')
			const rows = [r]
			const layout = layoutRow(r, selected, nameColumn(rows, width), width)
			expect(choiceDisplayWidth(layout.lead + layout.name + layout.meta)).toBeLessThanOrEqual(width)
		}
	})

	it('keeps the whole meta at 80 columns for an ordinary name, and drops whole parts at 60', () => {
		const r = row('release-notes', 'user')
		const wide = layoutRow(r, true, nameColumn([r], 80), 80)
		expect(wide.meta).toBe(metaParts(r).join(' · '))
		expect(wide.name.trimEnd()).toBe('release-notes')
		const narrow = layoutRow(row(longName, 'project, shared'), false, 20, 40)
		expect(narrow.meta.endsWith('tokens')).toBe(false)
		expect(narrow.meta).not.toMatch(/ ·$/)
	})

	it('puts the cursor and the mark in front: a tick for on, a ring for off', () => {
		const on = layoutRow(row('a', 'user'), true, 4, 80)
		expect(on.lead).toBe('❯ ✓ ')
		const off = { ...row('a', 'user'), state: 'off' as const }
		expect(layoutRow(off, false, 4, 80).lead).toBe('  ◯ ')
	})

	it('says locked in place of a state word, and shows the state word only for name-only and user-only', () => {
		const base = row('a', 'user')
		expect(metaParts({ ...base, state: 'on' })[0]).toBe('user')
		expect(metaParts({ ...base, state: 'user-only' })[0]).toBe('user-only')
		expect(metaParts({ ...base, state: 'off' })[0]).toBe('user')
		expect(metaParts({ ...base, locked: 'bad file' })[0]).toBe('locked')
	})
})
