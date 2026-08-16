import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { EditTool } from '../edit.js'

/**
 * `edit`'s diff is built by `edit.ts`, not by the presenter.
 *
 * The host used to reconstruct it by matching `name === 'edit'` and
 * reaching into the arguments. That worked for exactly two builtin names
 * and left every other tool that changes something with a truncated
 * string — and it put the knowledge of what an edit IS in the renderer.
 */

function presenter() {
	const registry = new ToolRegistry()
	registry.register(EditTool)
	return createToolPresenter(registry)
}

describe('the edit tool describes its own change', () => {
	it('returns a diff carrying the exact before and after', () => {
		// Removing `presentCall` from `edit.ts` fails this: the presenter has
		// no name-based special case to fall back on.
		const view = presenter().presentCall('edit', {
			path: '/tmp/a.ts',
			old_string: 'const a = 1',
			new_string: 'const a = 2',
		})

		expect(view).toEqual({
			kind: 'diff',
			path: '/tmp/a.ts',
			before: 'const a = 1',
			after: 'const a = 2',
		})
	})

	it('honours the oldStr/newStr aliases the schema accepts', () => {
		// Reading only `old_string` would give a generic label for a call the
		// tool itself executes perfectly well.
		const view = presenter().presentCall('edit', {
			path: '/tmp/a.ts',
			oldStr: 'x',
			newStr: 'y',
		})

		expect(view).toMatchObject({ kind: 'diff', before: 'x', after: 'y' })
	})

	it('declines to diff an INSERT, rather than inventing an empty before', () => {
		// An insert has no `before`. Substituting `''` renders as "the whole
		// file was added", which is a confident wrong picture — the generic
		// label is a better answer than a wrong diff.
		const view = presenter().presentCall('edit', {
			path: '/tmp/a.ts',
			insertLine: 'end',
			new_string: 'appended',
		})

		expect(view.kind).toBe('generic')
	})
})
