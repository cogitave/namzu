import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { admitToolFacts } from '../../admit-facts.js'
import { EditTool } from '../edit.js'
import { fileWriteResult } from '../file-write-result.js'
import { MAX_CARRIED_DIFF_LINES, lineDiff } from '../line-diff.js'

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`)

describe('line diff counts', () => {
	it('counts two far-apart changes as two lines each, not the span between', () => {
		const before = numbered(200)
		const after = [...before]
		after[1] = 'changed 2\n'
		after[197] = 'changed 198\n'
		const diff = lineDiff(before.join(''), after.join(''))
		expect([diff.added, diff.removed]).toEqual([2, 2])
		expect(diff.hunks).toHaveLength(2)
	})

	it('counts changes separated by unchanged lines by what changed', () => {
		const diff = lineDiff('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n')
		expect([diff.added, diff.removed]).toEqual([2, 2])
	})

	it('counts a final-newline-only change as one line on each side', () => {
		expect(lineDiff('one\ntwo', 'one\ntwo\n')).toMatchObject({ added: 1, removed: 1 })
		expect(lineDiff('one\ntwo\n', 'one\ntwo')).toMatchObject({ added: 1, removed: 1 })
	})

	it('treats the final newline as a terminator when lines go away', () => {
		expect(lineDiff('l1\nl2\nl3\nl4\nl5\nl6\n', 'l1\nl2\nl3\nl4\n')).toMatchObject({
			added: 0,
			removed: 2,
		})
	})

	it('keeps three lines of context and gives line numbers', () => {
		const before = numbered(20).join('')
		const after = before.replace('line 10\n', 'ten\n')
		const [hunk] = lineDiff(before, after).hunks
		expect(hunk).toMatchObject({ oldStart: 7, newStart: 7, oldLines: 7, newLines: 7 })
		expect(hunk?.lines).toEqual([
			' line 7',
			' line 8',
			' line 9',
			'-line 10',
			'+ten',
			' line 11',
			' line 12',
			' line 13',
		])
	})

	it('carries a bounded number of rows and still counts all of them', () => {
		const diff = lineDiff('', numbered(1000).join(''))
		expect(diff.added).toBe(1000)
		expect(diff.truncated).toBe(true)
		expect(diff.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(MAX_CARRIED_DIFF_LINES)
	})

	it('cuts a long row without splitting an emoji', () => {
		const long = `${'x'.repeat(498)}😀tail`
		const row = lineDiff('', `${long}\n`).hunks[0]?.lines[0] ?? ''
		expect(row.endsWith('…')).toBe(true)
		expect(row).not.toMatch(/[\uD800-\uDBFF]…$/)
	})
})

describe('write receipts use the real counts', () => {
	it('reports a 200-line overwrite with two far-apart changes as +2 -2', () => {
		const before = numbered(200)
		const after = [...before]
		after[1] = 'x\n'
		after[197] = 'y\n'
		const result = fileWriteResult('w.txt', before.join(''), after.join(''))
		expect(result.output).toContain('Updated w.txt (+2 -2)')
		expect(result.facts).toMatchObject({ kind: 'write', added: 2, removed: 2 })
	})

	it('counts a newline-only overwrite as +1 -1', () => {
		const result = fileWriteResult('w.txt', 'one', 'one\n')
		expect(result.facts).toMatchObject({ added: 1, removed: 1 })
	})

	it('carries a created file as one hunk of added lines', () => {
		const result = fileWriteResult('n.txt', undefined, 'a\nb\n')
		expect(result.facts).toMatchObject({
			operation: 'created',
			added: 2,
			removed: 0,
			hunks: [{ newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
		})
	})
})

describe('edit results use the real counts', () => {
	function project(body: string) {
		const dir = mkdtempSync(join(tmpdir(), 'edit-counts-'))
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'e.txt'), body)
		return { dir, ctx: { workingDirectory: dir, env: {}, abortSignal: new AbortController().signal } }
	}

	it('counts a replace_all by every place that changed', async () => {
		const { dir, ctx } = project('x\na\nx\nb\nx\nc\nx\n')
		const result = await EditTool.execute(
			{ path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true } as never,
			ctx as never,
		)
		expect(result.facts).toMatchObject({
			kind: 'edit',
			path: join(dir, 'e.txt'),
			replacements: 4,
			added: 4,
			removed: 4,
		})
		expect(result.output).toContain('(+4 -4)')
	})

	it('counts a batch and an insertion', async () => {
		const { ctx } = project('a\nb\nc\n')
		const batch = await EditTool.execute(
			{
				path: 'e.txt',
				edits: [
					{ old_string: 'a', new_string: 'A' },
					{ old_string: 'c', new_string: 'C' },
				],
			} as never,
			ctx as never,
		)
		expect(batch.facts).toMatchObject({ added: 2, removed: 2 })
		const inserted = await EditTool.execute(
			{ path: 'e.txt', insertLine: 'end', new_string: 'd\ne\n' } as never,
			ctx as never,
		)
		expect(inserted.facts).toMatchObject({ added: 2, removed: 0 })
	})
})

describe('recorded facts', () => {
	it('keep their counts and hunks when read back', () => {
		const facts = {
			kind: 'edit',
			path: '/p/a.ts',
			replacements: 1,
			added: 1,
			removed: 1,
			hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
		}
		expect(admitToolFacts(facts)).toEqual(facts)
	})

	it('drop hunks that are not diff rows', () => {
		const admitted = admitToolFacts({
			kind: 'write',
			path: '/p/a.ts',
			operation: 'updated',
			added: 1,
			removed: 0,
			hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['no marker'] }],
		})
		expect(admitted).toEqual({ kind: 'write', path: '/p/a.ts', operation: 'updated', added: 1, removed: 0 })
	})
})
