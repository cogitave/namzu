import { describe, expect, it } from 'vitest'

import { dryRunEdit } from '../edit.js'

/**
 * A host that shows a proposed edit before approval runs the tool's own apply
 * code through `dryRunEdit`. These pin each shape the tool accepts, so the
 * preview cannot drift from what `execute` writes.
 */
const body = 'alpha\nbeta\ngamma\nbeta\n'

describe('dryRunEdit', () => {
	it('applies a single unique replacement', () => {
		expect(dryRunEdit(body, { path: 'f', old_string: 'alpha', new_string: 'ALPHA' })).toEqual({
			success: true,
			content: 'ALPHA\nbeta\ngamma\nbeta\n',
		})
	})

	it('refuses an ambiguous replacement exactly as the tool does', () => {
		const result = dryRunEdit(body, { path: 'f', old_string: 'beta', new_string: 'B' })
		expect(result.success).toBe(false)
	})

	it('replaces every occurrence with replace_all', () => {
		expect(
			dryRunEdit(body, { path: 'f', old_string: 'beta', new_string: 'B', replace_all: true }),
		).toEqual({ success: true, content: 'alpha\nB\ngamma\nB\n' })
	})

	it('applies a batch in order, each against what the one before left', () => {
		expect(
			dryRunEdit(body, {
				path: 'f',
				edits: [
					{ old_string: 'alpha', new_string: 'one' },
					{ old_string: 'one', new_string: 'two' },
				],
			}),
		).toEqual({ success: true, content: 'two\nbeta\ngamma\nbeta\n' })
	})

	it('inserts after a line number and at the end', () => {
		expect(dryRunEdit(body, { path: 'f', insertLine: 1, new_string: 'inserted' })).toEqual({
			success: true,
			content: 'alpha\ninserted\nbeta\ngamma\nbeta\n',
		})
		expect(dryRunEdit(body, { path: 'f', insertLine: 'end', newStr: 'tail' })).toEqual({
			success: true,
			content: 'alpha\nbeta\ngamma\nbeta\ntail\n',
		})
	})

	it('accepts the oldStr/newStr aliases', () => {
		expect(dryRunEdit(body, { path: 'f', oldStr: 'gamma', newStr: 'G' })).toEqual({
			success: true,
			content: 'alpha\nbeta\nG\nbeta\n',
		})
	})

	it('refuses a no-op, a missing match and an invalid call', () => {
		expect(dryRunEdit(body, { path: 'f', old_string: 'alpha', new_string: 'alpha' }).success).toBe(
			false,
		)
		expect(dryRunEdit(body, { path: 'f', old_string: 'zzz', new_string: 'y' }).success).toBe(false)
		expect(dryRunEdit(body, { nope: true }).success).toBe(false)
	})
})
