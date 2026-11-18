import { expect, it } from 'vitest'
import {
	readSavedMemories,
	readSavedMemoryDetail,
	readSavedMemoryOutcome,
	readStandingInstructions,
} from './memory-protocol.js'

it('reads standing instructions and refuses an answer it cannot trust', () => {
	expect(readStandingInstructions({ text: 'a', limit: 10 })).toEqual({
		text: 'a',
		limit: 10,
		locked: false,
	})
	expect(readStandingInstructions({ text: '', limit: 10, locked: true }).locked).toBe(true)
	expect(() => readStandingInstructions({ text: 1, limit: 10 })).toThrow('cannot read')
	expect(() => readStandingInstructions(null)).toThrow('cannot read')
})

it('keeps the memories it can read and drops the rest', () => {
	const view = readSavedMemories({
		project: true,
		memories: [
			{ id: 'a', title: 'T', origin: 'namzu', state: 'retired', revision: 'r', excerpt: 'x' },
			{ id: 'b', title: 'No revision' },
			{ id: 'c', title: 'Odd', revision: 'r', origin: 'zzz', state: 'zzz' },
			'nonsense',
		],
	})
	expect(view.project).toBe(true)
	expect(view.memories.map((m) => [m.id, m.origin, m.state])).toEqual([
		['a', 'namzu', 'retired'],
		['c', 'conversation', 'active'],
	])
	expect(() => readSavedMemories({ memories: 'no' })).toThrow('cannot read')
})

it('reads one memory and an outcome', () => {
	expect(readSavedMemoryDetail({ found: false })).toEqual({ found: false })
	expect(
		readSavedMemoryDetail({ found: true, id: 'a', title: 't', text: 'x', revision: 'r' }),
	).toMatchObject({
		found: true,
		text: 'x',
	})
	expect(() => readSavedMemoryDetail({ found: true, id: 'a' })).toThrow('cannot read')
	expect(readSavedMemoryOutcome({ outcome: 'deleted' })).toBe('deleted')
	expect(() => readSavedMemoryOutcome({ outcome: 'maybe' })).toThrow('cannot read')
})
