import type { ToolFacts } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	CREATE_PREVIEW_ROWS,
	diffBodyFromFacts,
	proposedBody,
	proposedFromInput,
} from './diff-rows.js'
import { spansText } from './diff-view.js'

describe('the body under an edit or a write', () => {
	const hunks = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]

	it('names the session plan file as the plan, not by its folder', () => {
		const body = diffBodyFromFacts(
			{
				kind: 'write',
				path: '/h/.namzu/projects/p/s/plans/plan.md',
				operation: 'created',
				added: 2,
				hunks,
			},
			'/p',
		)
		expect(spansText(body?.diff.summary ?? [])).toBe('Wrote 2 lines to the plan')
	})

	it('shows a created file as its first lines, said as Wrote N lines to <path>', () => {
		const facts: ToolFacts = {
			kind: 'write',
			path: '/p/n.txt',
			operation: 'created',
			added: 2,
			hunks,
		}
		const body = diffBodyFromFacts(facts, '/p')
		expect(body?.rows).toEqual(['a', 'b'])
		expect(body?.diff.mode).toBe('file')
		expect(body?.diff.preview).toBe(CREATE_PREVIEW_ROWS)
		expect(CREATE_PREVIEW_ROWS).toBe(10)
		expect(spansText(body?.diff.summary ?? [])).toBe('Wrote 2 lines to n.txt')
		expect(body?.diff.summary?.filter((span) => span.bold).map((span) => span.text)).toEqual([
			'2',
			'n.txt',
		])
	})

	it('says one line in the singular', () => {
		const one = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }]
		const body = diffBodyFromFacts({
			kind: 'write',
			path: 'n.txt',
			operation: 'created',
			hunks: one,
		})
		expect(spansText(body?.diff.summary ?? [])).toBe('Wrote 1 line to n.txt')
	})

	it('shows an overwrite and an edit as Added N lines, removed M lines, with every hunk', () => {
		const change = [
			{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-x', '+y', '+z'] },
		]
		const write: ToolFacts = {
			kind: 'write',
			path: '/p/w.txt',
			operation: 'updated',
			added: 2,
			removed: 1,
			hunks: change,
		}
		const edit: ToolFacts = { kind: 'edit', path: '/p/e.txt', added: 2, removed: 1, hunks: change }
		for (const facts of [write, edit]) {
			const body = diffBodyFromFacts(facts)
			expect(spansText(body?.diff.summary ?? [])).toBe('Added 2 lines, removed 1 line')
			expect(body?.diff.preview).toBeUndefined()
			expect(body?.rows).toEqual([' 1 -x', ' 1 +y', ' 2 +z'])
		}
	})

	it('capitalises Removed when nothing was added, and leaves out the side with nothing', () => {
		const gone = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 0, lines: ['-a', '-b'] }]
		expect(
			spansText(diffBodyFromFacts({ kind: 'edit', path: 'e', hunks: gone })?.diff.summary ?? []),
		).toBe('Removed 2 lines')
		const grew = [{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1, lines: ['+a'] }]
		expect(
			spansText(diffBodyFromFacts({ kind: 'edit', path: 'e', hunks: grew })?.diff.summary ?? []),
		).toBe('Added 1 line')
	})

	it('counts from the facts when the kernel cut the hunks short', () => {
		const body = diffBodyFromFacts({
			kind: 'edit',
			path: 'e',
			added: 900,
			removed: 4,
			hunksTruncated: true,
			hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
		})
		expect(spansText(body?.diff.summary ?? [])).toBe('Added 900 lines, removed 4 lines')
		expect(body?.diff.truncated).toBe(true)
	})

	it('keeps the counts when a saved conversation has them but not the hunks', () => {
		const body = diffBodyFromFacts({ kind: 'edit', path: 'e', added: 2, removed: 1 })
		expect(spansText(body?.diff.summary ?? [])).toBe('Added 2 lines, removed 1 line')
		expect(body?.rows).toEqual([])
	})

	it('has no opinion about a change with nothing in it or another tool', () => {
		expect(diffBodyFromFacts({ kind: 'edit', path: '/p/e.txt' })).toBeUndefined()
		expect(diffBodyFromFacts({ kind: 'write', path: 'x', operation: 'unchanged' })).toBeUndefined()
		expect(diffBodyFromFacts({ kind: 'write', path: 'x', operation: 'wrote' })).toBeUndefined()
		expect(diffBodyFromFacts(undefined)).toBeUndefined()
		expect(diffBodyFromFacts({ kind: 'read', path: '/p/e.txt' })).toBeUndefined()
	})
})

describe('what a refused edit or write would have changed', () => {
	it('reads the proposal from the call input, under either spelling', () => {
		expect(proposedFromInput('edit', { path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
			kind: 'edit',
			path: 'a.ts',
			before: 'x',
			after: 'y',
		})
		expect(proposedFromInput('edit', { oldStr: 'x', newStr: 'y' })?.kind).toBe('edit')
		expect(proposedFromInput('write', { path: 'a.ts', content: 'hi' })).toEqual({
			kind: 'write',
			content: 'hi',
		})
		expect(proposedFromInput('bash', { command: 'ls' })).toBeUndefined()
		expect(proposedFromInput('edit', { path: 'a.ts' })).toBeUndefined()
	})

	it('draws a refused edit as a dimmed diff with no row cap', () => {
		const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n')
		const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
		const body = proposedBody({ kind: 'edit', before, after })
		expect(body?.diff.dim).toBe(true)
		expect(body?.diff.preview).toBeUndefined()
		expect(body?.diff.removed).toBe(30)
		expect(body?.rows).toHaveLength(60)
	})

	it('draws a refused write as its first lines, dimmed, folding after ten', () => {
		const content = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
		const body = proposedBody({ kind: 'write', content })
		expect(body?.diff).toMatchObject({ mode: 'file', dim: true, preview: 10, added: 25 })
		expect(body?.rows).toHaveLength(25)
	})
})
