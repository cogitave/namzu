import { describe, expect, it } from 'vitest'

import { addToObject, appendToArray, parseJsonc, stripJsonc } from './jsonc.js'

describe('jsonc', () => {
	it('reads comments and trailing commas', () => {
		const text = '// keys\n[\n  { "key": "a" }, /* two */\n  { "key": "b", },\n]\n'
		expect(parseJsonc(text)).toEqual([{ key: 'a' }, { key: 'b' }])
	})

	it('leaves comment-like text inside a string alone', () => {
		expect(stripJsonc('{"url": "http://x/*y*/"}')).toBe('{"url": "http://x/*y*/"}')
	})

	it('appends to a list and keeps the comments the person wrote', () => {
		const text = '// mine\n[\n  { "key": "a" } // first\n]\n'
		const next = appendToArray(text, '  { "key": "b" }')
		expect(next).toContain('// mine')
		expect(next).toContain('// first')
		expect(parseJsonc(next)).toEqual([{ key: 'a' }, { key: 'b' }])
	})

	it('appends to an empty list and after a trailing comma', () => {
		expect(parseJsonc(appendToArray('[]', '{"k":1}'))).toEqual([{ k: 1 }])
		expect(parseJsonc(appendToArray('[\n{"k":1},\n]', '{"k":2}'))).toEqual([{ k: 1 }, { k: 2 }])
	})

	it('is not fooled by a bracket inside a string', () => {
		const next = appendToArray('[{"k":"]"}]', '{"k":2}')
		expect(parseJsonc(next)).toEqual([{ k: ']' }, { k: 2 }])
	})

	it('adds a member to an object', () => {
		expect(parseJsonc(addToObject('{\n  "a": 1\n}', '  "b": 2'))).toEqual({ a: 1, b: 2 })
		expect(parseJsonc(addToObject('{}', '"b": 2'))).toEqual({ b: 2 })
	})

	it('returns nothing when there is no list to add to', () => {
		expect(appendToArray('{"a":1}', '1')).toBe('')
	})
})
