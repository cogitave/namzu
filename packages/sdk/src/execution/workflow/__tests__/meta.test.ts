import { describe, expect, it } from 'vitest'

import { WorkflowScriptError } from '../errors.js'
import { parseWorkflowMeta, splitWorkflowScript } from '../meta.js'

describe('parseWorkflowMeta', () => {
	it('reads a pure literal without running anything', () => {
		const meta = parseWorkflowMeta(`// leading comment
/* block */
export const meta = {
	name: 'surum-denetimi',
	"description": "Paketleri tara \\u0041 \\x42 \\u{1F600}",
	whenToUse: \`when asked\`,
	phases: [{ title: 'Tarama' }, { title: 'Düzeltme', detail: 'yalnızca güvenli', model: 'x', },],
};
phase('Tarama')`)
		expect(meta.name).toBe('surum-denetimi')
		expect(meta.description).toBe('Paketleri tara A B \u{1F600}')
		expect(meta.whenToUse).toBe('when asked')
		expect(meta.phases).toEqual([
			{ title: 'Tarama' },
			{ title: 'Düzeltme', detail: 'yalnızca güvenli', model: 'x' },
		])
	})

	it('accepts a meta with no phases', () => {
		expect(parseWorkflowMeta("export const meta = { name: 'a', description: 'b' }").phases).toEqual(
			[],
		)
	})

	it.each([
		['name: someVariable', 'pure literal'],
		["name: 'a'.toUpperCase()", 'pure literal'],
		['name: `a${1}`', 'substitutions'],
		['...other', 'pure literal'],
		['[computed]: 1', 'pure literal'],
		["name: 'a', phases: [make()]", 'pure literal'],
		["name: 'a', phases: undefined", 'pure literal'],
		['name: 1 + 2', 'pure literal'],
		['__proto__: {}', '__proto__'],
		["name: 'a', name: 'b'", 'repeats'],
		["name: 'a', extra: 1", 'unknown key'],
		["name: 'a', phases: [{ title: 'x' }, { title: ' x ' }]", 'repeats the title'],
		["name: 'a', phases: 'x'", 'array'],
		["name: 'a', phases: [{ nope: 1 }]", 'unknown key'],
		["name: 'a\nb'", 'Unterminated'],
		["name: 'a\\q'", 'Bad escape'],
	])('refuses a non-literal meta: %s', (body, message) => {
		const run = () =>
			parseWorkflowMeta(
				`export const meta = { ${body.includes('description') ? '' : "description: 'd', "}${body} }`,
			)
		expect(run).toThrow(WorkflowScriptError)
		expect(run).toThrow(message)
	})

	it('names the line and column of the offending token', () => {
		expect(() =>
			parseWorkflowMeta("export const meta = {\n  name: 'a',\n  description: describe(),\n}"),
		).toThrow(/line 3, column \d+/)
	})

	it('requires a description and a name', () => {
		expect(() => parseWorkflowMeta("export const meta = { name: 'a' }")).toThrow('description')
		expect(() => parseWorkflowMeta("export const meta = { description: 'a' }")).toThrow('name')
	})

	it('requires meta to be the first statement', () => {
		expect(() =>
			parseWorkflowMeta("const x = 1\nexport const meta = { name: 'a', description: 'b' }"),
		).toThrow('must start with')
		expect(() => parseWorkflowMeta('return 1')).toThrow('must start with')
	})

	it('refuses an unterminated comment, deep nesting and a huge meta', () => {
		expect(() => parseWorkflowMeta('/* never closed')).toThrow('Unterminated comment')
		const deep = `export const meta = { name: 'a', description: 'b', phases: ${'['.repeat(20)}${']'.repeat(20)} }`
		expect(() => parseWorkflowMeta(deep)).toThrow('nested too deeply')
		const big = `export const meta = { name: 'a', description: '${'x'.repeat(600)}' }`
		expect(() => parseWorkflowMeta(big)).toThrow('500 characters')
	})
})

describe('splitWorkflowScript', () => {
	it('blanks the meta statement and keeps every line break', () => {
		const source = "// c\nexport const meta = {\n name: 'a',\n description: 'b',\n}\nreturn 1"
		const { body } = splitWorkflowScript(source)
		expect(body.split('\n')).toHaveLength(source.split('\n').length)
		expect(body).not.toContain('meta')
		expect(body.endsWith('return 1')).toBe(true)
	})
})
