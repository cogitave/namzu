import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fileTipHistory, readTipHistory, tipHistoryPath } from './tip-history.js'

const home = () => mkdtempSync(join(tmpdir(), 'namzu-tips-'))

describe('the tip history file', () => {
	it('starts empty and counts each launch once per call', () => {
		const dir = home()
		const store = fileTipHistory(dir)
		expect(store.read()).toEqual({ launches: 0, shown: {}, used: {} })
		store.recordLaunch()
		store.recordLaunch()
		expect(store.read().launches).toBe(2)
	})

	it('records a showing at the current launch and counts the total', () => {
		const store = fileTipHistory(home())
		store.recordLaunch()
		store.recordShown('goal')
		store.recordLaunch()
		store.recordShown('goal')
		store.recordShown('goal')
		expect(store.read().shown.goal).toEqual({ lastLaunch: 2, total: 2 })
	})

	it('counts command uses', () => {
		const store = fileTipHistory(home())
		store.recordUse('goal')
		store.recordUse('goal')
		expect(store.read().used.goal).toBe(2)
	})

	it('reads a damaged file as empty and keeps only well-formed entries', () => {
		const dir = home()
		const store = fileTipHistory(dir)
		store.recordLaunch()
		writeFileSync(tipHistoryPath(dir), '{not json')
		expect(store.read()).toEqual({ launches: 0, shown: {}, used: {} })
		writeFileSync(
			tipHistoryPath(dir),
			JSON.stringify({
				launches: 4,
				shown: { a: { lastLaunch: 2, total: 1 }, b: { lastLaunch: -1, total: 1 }, c: 5 },
				used: { x: 2, y: 'many' },
			}),
		)
		expect(readTipHistory(tipHistoryPath(dir))).toEqual({
			launches: 4,
			shown: { a: { lastLaunch: 2, total: 1 } },
			used: { x: 2 },
		})
	})

	it('drops a write that cannot happen instead of throwing', () => {
		const dir = home()
		// a file where the directory should be
		writeFileSync(join(dir, '.namzu'), 'in the way')
		const store = fileTipHistory(dir)
		expect(() => store.recordLaunch()).not.toThrow()
		expect(store.read().launches).toBe(0)
	})
})
