import { expect, it } from 'vitest'
import { attentionDescription, needsYouIds } from './attention-state.js'

it('counts running conversations with an answer waiting, each once', () => {
	expect(
		needsYouIds([
			{ id: 'a', running: true, waiting: 1 },
			{ id: 'b', running: true, waiting: 0 },
			{ id: 'c', running: false, waiting: 2 },
			{ id: 'd', running: true, waiting: 3 },
			{ id: 'a', running: true, waiting: 1 },
			{ id: 'pal', running: true, waiting: 1, pal: true },
		]),
	).toEqual(['a', 'd'])
	expect(needsYouIds([])).toEqual([])
})

it('describes the count for a screen reader', () => {
	expect(attentionDescription(0)).toBe('')
	expect(attentionDescription(1)).toBe('1 conversation needs you')
	expect(attentionDescription(3)).toBe('3 conversations need you')
})
