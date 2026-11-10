import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { describeValidationIssues, renderIssuePath } from './validation-issues.js'

function render(schema: z.ZodType, input: unknown): string {
	const parsed = schema.safeParse(input)
	if (parsed.success) throw new Error('expected a failure')
	return describeValidationIssues(parsed.error.issues)
}

describe('validation issues as plain sentences', () => {
	it('renders list positions the way a call writes them', () => {
		expect(renderIssuePath(['edits', 0, 'old_string'])).toBe('edits[0].old_string')
		expect(renderIssuePath([])).toBe('')
	})

	it('an empty string names the field and the fix', () => {
		expect(render(z.object({ a: z.string().min(1) }), { a: '' })).toBe(
			'"a" must not be empty; send the text itself',
		)
	})

	it('a short list says how many entries it needs, and that it may be left out', () => {
		expect(render(z.object({ a: z.array(z.string()).min(2) }), { a: ['x'] })).toBe(
			'"a" is a list with too few entries; it needs at least 2 entries, or leave the field out',
		)
		expect(render(z.object({ a: z.array(z.string()).min(1) }), { a: [] })).toContain(
			'at least 1 entry',
		)
	})

	it('a missing field and a wrong type', () => {
		const schema = z.object({ a: z.string(), n: z.number().optional() })
		expect(render(schema, {})).toBe('"a" is missing; send it as a string')
		expect(render(schema, { a: 'x', n: 'five' })).toBe('"n" must be a number, not a string')
	})

	it('an unknown field is named and the fix is to remove it', () => {
		expect(render(z.object({ a: z.string() }).strict(), { a: 'x', extra: 1 })).toBe(
			'a field this tool does not take: "extra". Remove it',
		)
	})

	it('a top-level refinement with no path keeps its message, minus the trailing period', () => {
		const schema = z.object({ a: z.string() }).refine(() => false, 'Send a, not both.')
		expect(render(schema, { a: 'x' })).toBe('Send a, not both')
	})

	it('anything else keeps its own message', () => {
		expect(render(z.object({ a: z.string().regex(/^x$/, 'must be x.') }), { a: 'y' })).toBe(
			'a: must be x',
		)
	})
})
