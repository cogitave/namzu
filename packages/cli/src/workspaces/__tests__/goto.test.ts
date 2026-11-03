import { describe, expect, it } from 'vitest'
import { filterGoto, gotoRows } from '../goto.js'
import { Roster } from '../roster.js'

function sample(): Roster {
	const roster = new Roster()
	const a = roster.addWorkspace('/work/alpha', 'alpha')
	roster.addTab(a, roster.addSession(a, 's1'))
	const second = roster.addSession(a, 's2', 'build')
	roster.addTab(a, second, 'logs')
	const b = roster.addWorkspace('/work/beta', 'beta')
	roster.addTab(b, roster.addSession(b, 's3'))
	return roster
}

describe('the go-to tree', () => {
	it("lists workspaces, their tabs and each tab's panes in order", () => {
		const rows = gotoRows(sample())
		expect(rows.map((r) => [r.depth, r.text])).toEqual([
			[0, 'alpha'],
			[1, 'tab 1'],
			[2, 'session 1'],
			[1, 'logs'],
			[2, 'build'],
			[0, 'beta'],
			[1, 'tab 1'],
			[2, 'session 1'],
		])
	})

	it('keeps all rows for an empty filter', () => {
		const rows = gotoRows(sample())
		expect(filterGoto(rows, '  ')).toHaveLength(rows.length)
	})

	it('keeps a match with its parents, and a matching workspace with everything under it', () => {
		const rows = gotoRows(sample())
		expect(filterGoto(rows, 'BUILD').map((r) => r.text)).toEqual(['alpha', 'logs', 'build'])
		expect(filterGoto(rows, 'beta').map((r) => r.text)).toEqual(['beta', 'tab 1', 'session 1'])
		expect(filterGoto(rows, 'zzz')).toEqual([])
	})
})
