import { describe, expect, it } from 'vitest'

import { shortenPathToFit } from '../shorten-path.js'

describe('shortenPathToFit', () => {
	it('leaves a path that fits alone', () => {
		expect(shortenPathToFit('~/work/namzu', 40)).toBe('~/work/namzu')
	})

	it('shortens a Windows path from the left and starts at a folder, not mid-name', () => {
		const shortened = shortenPathToFit('C:\\Users\\arda\\Documents\\Claude\\Projects\\New project 3', 30)
		expect(shortened.length).toBeLessThanOrEqual(30)
		expect(shortened).toMatch(/^…\\/)
		expect(shortened.endsWith('New project 3')).toBe(true)
	})

	it('still shortens a POSIX path at a slash', () => {
		expect(shortenPathToFit('/home/arda/work/namzu/packages/cli', 22)).toBe('…/namzu/packages/cli')
	})

	it('returns nothing when there is no room', () => {
		expect(shortenPathToFit('/a/b', 0)).toBe('')
		expect(shortenPathToFit('/a/b/c/d', 1)).toBe('…')
	})
})
