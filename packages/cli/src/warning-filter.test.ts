import { describe, expect, it, vi } from 'vitest'

import { isSqliteExperimentalWarning, suppressSqliteExperimentalWarning } from './warning-filter.js'

const SQLITE = 'SQLite is an experimental feature and might change at any time'

function target() {
	const emitted: unknown[][] = []
	const emitWarning = vi.fn((...args: unknown[]) => {
		emitted.push(args)
	})
	return {
		emitWarning: emitWarning as unknown as typeof process.emitWarning,
		emitted,
	}
}

describe('the SQLite experimental warning', () => {
	it('is not printed', () => {
		const fake = target()
		suppressSqliteExperimentalWarning(fake)
		fake.emitWarning(SQLITE, 'ExperimentalWarning')
		expect(fake.emitted).toEqual([])
	})

	it('is not printed when it arrives as an Error or with an options object', () => {
		const fake = target()
		suppressSqliteExperimentalWarning(fake)
		const error = new Error(SQLITE)
		error.name = 'ExperimentalWarning'
		fake.emitWarning(error)
		fake.emitWarning(SQLITE, { type: 'ExperimentalWarning' })
		expect(fake.emitted).toEqual([])
	})

	it('leaves every other warning to print, with the arguments it was given', () => {
		const fake = target()
		suppressSqliteExperimentalWarning(fake)
		fake.emitWarning('Another feature is experimental', 'ExperimentalWarning')
		fake.emitWarning('Buffer() is deprecated', 'DeprecationWarning', 'DEP0005')
		fake.emitWarning(SQLITE, 'DeprecationWarning')
		fake.emitWarning('The SQLite file is large')
		expect(fake.emitted).toEqual([
			['Another feature is experimental', 'ExperimentalWarning'],
			['Buffer() is deprecated', 'DeprecationWarning', 'DEP0005'],
			[SQLITE, 'DeprecationWarning'],
			['The SQLite file is large'],
		])
	})

	it('puts the original back when asked, and only once', () => {
		const fake = target()
		const before = fake.emitWarning
		const restore = suppressSqliteExperimentalWarning(fake)
		expect(fake.emitWarning).not.toBe(before)
		restore()
		expect(fake.emitWarning).toBe(before)
		restore()
		expect(fake.emitWarning).toBe(before)
	})

	it('is recognised by its type and its sentence together, not by either alone', () => {
		expect(isSqliteExperimentalWarning(SQLITE, ['ExperimentalWarning'])).toBe(true)
		expect(isSqliteExperimentalWarning(SQLITE, [])).toBe(false)
		expect(isSqliteExperimentalWarning('Something is experimental', ['ExperimentalWarning'])).toBe(
			false,
		)
	})
})
