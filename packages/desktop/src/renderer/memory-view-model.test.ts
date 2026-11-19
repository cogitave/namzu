import { expect, it } from 'vitest'
import type { SavedMemory } from '../shared/memory-protocol.js'
import {
	DELETE_COPY,
	filterMemories,
	instructionsNote,
	instructionsToSave,
	originText,
	outcomeProblem,
	stateText,
} from './memory-view-model.js'

const memory = (id: string, title: string, excerpt: string): SavedMemory => ({
	id,
	title,
	origin: 'you',
	state: 'active',
	createdAt: 0,
	updatedAt: 0,
	revision: 'r',
	excerpt,
})
const list = [
	memory('1', 'Prefers tabs', 'The person prefers tabs over spaces.'),
	memory('2', 'Release day', 'Releases go out on Fridays.'),
]

it('searches the title and the start of the text, every word of the query', () => {
	expect(filterMemories(list, '')).toEqual(list)
	expect(filterMemories(list, 'FRIDAYS').map((m) => m.id)).toEqual(['2'])
	expect(filterMemories(list, 'tabs spaces').map((m) => m.id)).toEqual(['1'])
	expect(filterMemories(list, 'tabs fridays')).toEqual([])
})

it('says who saved a memory and its state in plain words', () => {
	expect(originText('you')).toBe('You saved it')
	expect(originText('namzu')).toBe('Namzu saved it')
	expect(originText('conversation')).toBe('Saved from a conversation')
	expect(stateText('active')).toBeUndefined()
	expect(stateText('retired')).toBe('Not used any more')
	expect(stateText('set-aside')).toBe('Not used for now')
})

it('turns a refused change into one sentence with a next step', () => {
	expect(outcomeProblem('updated')).toBeUndefined()
	expect(outcomeProblem('changed')).toMatch(/open it again/)
	expect(outcomeProblem('gone')).toMatch(/already gone/)
})

it('asks before a delete and says what stays', () => {
	expect(DELETE_COPY.description).toMatch(/will not recall it again/)
	expect(DELETE_COPY.description).toMatch(/keeps what it read/)
})

it('saves instructions only when they changed, and removes blank ones', () => {
	expect(instructionsToSave('a', 'a')).toBeUndefined()
	expect(instructionsToSave('b', 'a')).toBe('b')
	expect(instructionsToSave('  \n', 'a')).toBe('')
})

it('says the cost under the instructions and that a long text was cut', () => {
	expect(instructionsNote(10, 100)).toBe('It is sent with every message, so keep it short.')
	expect(instructionsNote(100, 100)).toMatch(/rest was left out/)
	expect(instructionsNote(99, 100)).not.toMatch(/left out/)
})
