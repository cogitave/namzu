import { describe, expect, it } from 'vitest'

import { applyEdit } from '../edit-apply.js'
import { renderNumberedRead } from '../read-render.js'

/**
 * A model that reads a tab-indented file sees the line number, then the
 * line. When the first tab of an indented line is taken for the separator,
 * every line of its `old_string` is one level short and nothing matches. An
 * edit whose lines match in exactly one place, shifted by one constant amount,
 * is applied with that shift; anything else is refused with the file's lines
 * shown with their whitespace made visible.
 */

function run(content: string, oldString: string, newString: string) {
	return applyEdit(content, [{ operation: 'replace', oldString, newString, replace_all: false }])
}

const TSX = [
	'export function Collected() {',
	'\tconst rows = useRows()',
	'\treturn (',
	'\t\t<ul>',
	'\t\t\t{rows.map((row) => (',
	'\t\t\t\t<li key={row.id}>{row.name}</li>',
	'\t\t\t))}',
	'\t\t</ul>',
	'\t)',
	'}',
	'',
].join('\n')

describe('read output separates the line number from the file', () => {
	it('puts an arrow after a right-aligned number, so a tab after it is the file own', () => {
		const out = renderNumberedRead('a\n\tb\n', {}).output
		expect(out).toBe('     1→a\n     2→\tb')
	})
})

describe('edit with indentation one level short', () => {
	it('applies the exact failing shape: tab-indented TSX, one tab short on every line', () => {
		const oldString = [
			'\t<ul>',
			'\t\t{rows.map((row) => (',
			'\t\t\t<li key={row.id}>{row.name}</li>',
			'\t\t))}',
		].join('\n')
		const newString = [
			'\t<ul>',
			'\t\t{rows.map((row) => (',
			'\t\t\t<li key={row.id}>{row.label}</li>',
			'\t\t))}',
		].join('\n')
		const result = run(TSX, oldString, newString)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.content).toContain(
			'\t\t\t\t<li key={row.id}>{row.label}</li>\n\t\t\t))}\n\t\t</ul>',
		)
		expect(result.content).toContain('\t\t<ul>\n\t\t\t{rows.map')
		expect(result.notes).toHaveLength(1)
		expect(result.notes[0]).toMatch(/adjusted indentation/)
	})

	it('only changes leading whitespace: inner spacing of a line is kept', () => {
		const file = '\tif (a  &&  b) {\n\t\tgo(  1 )\n\t}\n'
		const result = run(file, 'if (a  &&  b) {\n\tgo(  1 )\n}', 'if (a  &&  b) {\n\tgo(  2 )\n}')
		expect(result.success).toBe(true)
		if (result.success) expect(result.content).toBe('\tif (a  &&  b) {\n\t\tgo(  2 )\n\t}\n')
	})

	it('refuses when two places match', () => {
		const file = '\tfoo()\n\tbar()\n\n\t\tfoo()\n\t\tbar()\n'
		const result = run(file, 'foo()\nbar()', 'baz()')
		expect(result.success).toBe(false)
		if (!result.success) expect(result.reason).toBe('text_not_found')
	})

	it('refuses when the indentation differs by a different amount on different lines', () => {
		const file = '\t\tfoo()\n\t\t\tbar()\n'
		const result = run(file, '\tfoo()\n\tbar()', 'x')
		expect(result.success).toBe(false)
	})

	it('adapts a spaces-indented file asked for with tabs, keeping spaces', () => {
		const file = 'function f() {\n    if (x) {\n        go()\n    }\n}\n'
		const result = run(file, '\tif (x) {\n\t\tgo()\n\t}', '\tif (x) {\n\t\tgo(1)\n\t}')
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.content).toBe('function f() {\n    if (x) {\n        go(1)\n    }\n}\n')
		}
	})

	it('adapts a tab-indented file asked for with spaces, writing tabs', () => {
		const file = 'f {\n\tif (x) {\n\t\tgo()\n\t}\n}\n'
		const result = run(
			file,
			'    if (x) {\n        go()\n    }',
			'    if (x) {\n        go(1)\n    }',
		)
		expect(result.success).toBe(true)
		if (result.success) expect(result.content).toBe('f {\n\tif (x) {\n\t\tgo(1)\n\t}\n}\n')
	})

	it('works on a CRLF file and keeps its line endings', () => {
		const file = 'a\r\n\tb()\r\n\t\tc()\r\nd\r\n'
		const result = run(file, 'b()\n\tc()', 'b(1)\n\tc(2)')
		expect(result.success).toBe(true)
		if (result.success) expect(result.content).toBe('a\r\n\tb(1)\r\n\t\tc(2)\r\nd\r\n')
	})

	it('does not use the road for replace_all', () => {
		const result = applyEdit('\tfoo()\n', [
			{ operation: 'replace', oldString: 'foo()', newString: 'bar()', replace_all: true },
		])
		// `foo()` is a substring of the line, so this is an ordinary exact match.
		expect(result.success).toBe(true)
		const lines = applyEdit('\tfoo()\n\tbar()\n', [
			{ operation: 'replace', oldString: 'foo()\nbar()', newString: 'z', replace_all: true },
		])
		expect(lines.success).toBe(false)
	})
})

describe('a refusal shows the real lines with visible whitespace', () => {
	it('names the file and model indentation and prints tabs as arrows', () => {
		const result = run(TSX, '\t{rows.map((row) => (\n\t\t<li>nothing</li>', 'x')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error).toContain('is at line 5')
		expect(result.error).toContain('3 tabs')
		expect(result.error).toContain('1 tab')
		expect(result.error).toContain('     4| →→<ul>')
		expect(result.error).toContain('     5| →→→{rows.map')
	})

	it('shows spaces as dots and keeps the excerpt bounded', () => {
		const body = Array.from({ length: 80 }, (_, i) => `    line number ${i}`).join('\n')
		const result = run(body, '  line number 10\n  missing', 'x')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error).toContain('····line number 10')
		expect(result.error.split('\n').length).toBeLessThanOrEqual(20)
	})
})

describe('a batch reports every hunk that does not apply', () => {
	it('names each failing index in one error and writes nothing', () => {
		const file = 'one\ntwo\nthree\n'
		const result = applyEdit(file, [
			{ operation: 'replace', oldString: 'one', newString: '1', replace_all: false },
			{ operation: 'replace', oldString: 'zzz', newString: '2', replace_all: false },
			{ operation: 'replace', oldString: 'yyy', newString: '3', replace_all: false },
		])
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error).toContain('edits[1] of 3')
		expect(result.error).toContain('edits[2] of 3')
		expect(result.error).not.toContain('edits[0]')
		expect(result.error.match(/Nothing was written/g)).toHaveLength(1)
	})
})

describe('the tolerant road never changes what is not indentation', () => {
	it('refuses when a matched line has trailing whitespace the edit would drop', () => {
		const result = run('\tfoo  \n\tbar\n', 'foo\nbar', 'foo\nbaz')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error).toContain('not found')
	})

	it('re-indents a tab-written new_string at the file indent unit, not at four', () => {
		const file = 'root:\n  a:\n    c: 1\n'
		const result = run(file, '\tc: 1', '\tc: 2\n\t\td: 3')
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.content).toBe('root:\n  a:\n    c: 2\n      d: 3\n')
	})
})

describe('a batch error stays bounded', () => {
	it('gives the file lines to the first hunks only and caps the whole text', () => {
		const file = `${Array.from({ length: 60 }, (_, i) => `\tconst value${i} = compute(${i})`).join('\n')}\n`
		const ops = Array.from({ length: 40 }, (_, i) => ({
			operation: 'replace' as const,
			oldString: `const value${i} = compute(${i})\nnot in the file`,
			newString: 'x',
			replace_all: false,
		}))
		const result = applyEdit(file, ops)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.length).toBeLessThan(6600)
		expect(result.error).toContain('edits[0] of 40')
		expect(result.error.match(/The file's lines/g)).toHaveLength(3)
	})
})
