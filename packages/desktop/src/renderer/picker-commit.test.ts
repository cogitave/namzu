import { describe, expect, it } from 'vitest'
import { commitsOnKey, committableProject } from './picker-commit.js'

describe('commitsOnKey', () => {
	it('commits on Enter only', () => {
		expect(commitsOnKey('Enter')).toBe(true)
		for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'])
			expect(commitsOnKey(key)).toBe(false)
	})
	it('leaves Space to the native click', () => {
		expect(commitsOnKey(' ')).toBe(false)
	})
})

describe('committableProject', () => {
	const choices = [{ id: 'a' }, { id: 'b' }]
	it('finds a listed project', () => {
		expect(committableProject(choices, 'b')).toEqual({ id: 'b' })
	})
	it('refuses an unknown id', () => {
		expect(committableProject(choices, 'z')).toBeUndefined()
	})
})
