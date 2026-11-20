import { describe, expect, it } from 'vitest'

import { UNDO_LIMIT, createUndoStack } from './composer-undo.js'

const snap = (value: string) => ({ value, cursor: value.length, spans: [] })

/** Type `text` one character at a time through the stack. */
function type(stack: ReturnType<typeof createUndoStack>, from: string, text: string): string {
	let value = from
	for (const ch of text) {
		stack.record(snap(value), value + ch, ch)
		value += ch
	}
	return value
}

describe('composer undo', () => {
	it('takes a typed word back as one edit', () => {
		const stack = createUndoStack()
		type(stack, '', 'hello')
		expect(stack.undo()?.value).toBe('')
		expect(stack.undo()).toBeUndefined()
	})

	it('goes back a word at a time across spaces', () => {
		const stack = createUndoStack()
		type(stack, '', 'hello world')
		expect(stack.undo()?.value).toBe('hello ')
		expect(stack.undo()?.value).toBe('hello')
		expect(stack.undo()?.value).toBe('')
	})

	it('ends a typed run at any other kind of edit', () => {
		const stack = createUndoStack()
		const typed = type(stack, '', 'ab')
		stack.record(snap(typed), 'a', null)
		type(stack, 'a', 'c')
		expect(stack.undo()?.value).toBe('a')
		expect(stack.undo()?.value).toBe('ab')
		expect(stack.undo()?.value).toBe('')
	})

	it('keeps the last fifty edits', () => {
		const stack = createUndoStack()
		for (let i = 0; i < UNDO_LIMIT + 10; i++) stack.record(snap(`v${i}`), `v${i + 1}`, null)
		expect(stack.size).toBe(UNDO_LIMIT)
	})

	it('forgets everything on clear', () => {
		const stack = createUndoStack()
		type(stack, '', 'abc')
		stack.clear()
		expect(stack.undo()).toBeUndefined()
	})

	it('collapseSince folds the drafts of one insert into the first, so it undoes in one step', () => {
		const stack = createUndoStack()
		const at = (value: string) => ({ value, cursor: value.length, spans: [] })
		const mark = stack.saved
		stack.record(at(''), 'a', 'a')
		stack.record(at('a'), 'a b', ' ')
		stack.record(at('a b'), 'a b c', 'c')
		expect(stack.size).toBe(3)
		stack.collapseSince(mark)
		expect(stack.size).toBe(1)
		expect(stack.undo()?.value).toBe('')
		expect(stack.undo()).toBeUndefined()
	})

	it('collapseSince still folds an insert once the stack is full and dropping its oldest', () => {
		const stack = createUndoStack(3)
		const at = (value: string) => ({ value, cursor: value.length, spans: [] })
		for (const v of ['p', 'q', 'r', 's']) stack.record(at(v), `${v}!`, null)
		expect(stack.size).toBe(3)
		const mark = stack.saved
		stack.record(at('0'), '1', 'a')
		stack.record(at('1'), '2', ' ')
		stack.record(at('2'), '3', 'c')
		expect(stack.size).toBe(3)
		stack.collapseSince(mark)
		expect(stack.size).toBe(1)
		expect(stack.undo()?.value).toBe('0')
	})

	it('breakRun makes the next typed letter an edit of its own', () => {
		const stack = createUndoStack()
		const at = (value: string) => ({ value, cursor: value.length, spans: [] })
		stack.record(at(''), 'a', 'a')
		stack.breakRun()
		stack.record(at('a'), 'ab', 'b')
		expect(stack.size).toBe(2)
	})
})
