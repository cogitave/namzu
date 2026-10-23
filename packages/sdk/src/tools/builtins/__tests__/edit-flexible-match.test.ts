import { describe, expect, it } from 'vitest'
import { type NormalizedEditInput, applyEdit } from '../edit-apply.js'

/** One replace operation, the shape `normalizeEditInput` produces. */
function replace(oldString: string, newString: string, replace_all = false): NormalizedEditInput {
	return { operation: 'replace', oldString, newString, replace_all }
}

function run(content: string, ...ops: NormalizedEditInput[]) {
	return applyEdit(content, ops)
}

describe('edit flexible matching (reference parity)', () => {
	it('still matches and replaces exactly, and still refuses a genuine miss', () => {
		expect(run('const a = 1', replace('a = 1', 'a = 2'))).toMatchObject({
			success: true,
			content: 'const a = 2',
		})
		expect(run('hello world', replace('xyz', 'abc'))).toMatchObject({ success: false })
	})

	it('matches a straight quote in the file against a curly quote in old_string', () => {
		const content = 'const label = "Ready"'
		// old_string carries curly double quotes; the file has straight ones.
		// new_string keeps the quotes the model wrote, since the matched span is
		// straight (nothing to carry over).
		const out = run(content, replace('“Ready”', '"Done"'))
		expect(out).toMatchObject({ success: true, content: 'const label = "Done"' })
	})

	it("matches a curly quote in the file and keeps the file's curly style in new_string", () => {
		const content = 'title = “Hello”'
		const out = run(content, replace('"Hello"', '"Goodbye"'))
		expect(out).toMatchObject({ success: true, content: 'title = “Goodbye”' })
	})

	it('matches a \\uXXXX escape in old_string against the character in the file', () => {
		const content = 'let s = "café"'
		const out = run(content, replace('caf\\u00e9', 'caf\\u00e9X'))
		expect(out).toMatchObject({ success: true, content: 'let s = "caféX"' })
	})

	it('matches a character in old_string against a \\uXXXX escape in the file', () => {
		// The file literally contains backslash-u-0-0-e-9.
		const content = 'path = "caf\\u00e9"'
		const out = run(content, replace('café', 'cafébar'))
		expect(out.success).toBe(true)
		if (out.success) expect(out.content).toBe('path = "caf\\u00e9bar"')
	})

	it('a deletion takes the trailing newline with it, leaving no blank line', () => {
		expect(run('a\nb\nc\n', replace('b', ''))).toMatchObject({
			success: true,
			content: 'a\nc\n',
		})
	})

	it('does not resolve across a whitespace/indentation difference (as the reference does not)', () => {
		const content = '\tif (x) {\n\t\treturn 1\n\t}'
		// old_string uses spaces where the file uses tabs: a real miss, both tools.
		const out = run(content, replace('  if (x) {', '  if (y) {'))
		expect(out).toMatchObject({ success: false })
	})

	it('still enforces uniqueness after a flexible match', () => {
		const content = 'x = “a”; y = “a”'
		const out = run(content, replace('"a"', '"b"'))
		expect(out).toMatchObject({ success: false })
		if (!out.success) expect(out.error).toContain('not unique')
	})
})
