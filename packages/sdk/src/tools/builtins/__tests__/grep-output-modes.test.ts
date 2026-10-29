import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { DEFAULT_HEAD_LIMIT, GrepTool, MAX_LINE_COLUMNS } from '../grep.js'

/**
 * Grep returned matching lines and nothing else, capped at 100 matches with no
 * way to page. The default is the list of matching files,
 * newest first, with `content` and `count` as the other two modes.
 */

function workspace(files: Record<string, string>, mtimes: Record<string, number> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-grep-modes-'))
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, '..'), { recursive: true })
		writeFileSync(join(dir, name), body)
		const t = mtimes[name]
		if (t !== undefined) utimesSync(join(dir, name), t, t)
	}
	return {
		dir,
		context: { workingDirectory: dir, env: {} } as unknown as ToolContext,
	}
}

const run = (context: ToolContext, extra: Record<string, unknown> = {}, pattern = 'needle') => {
	const parsed = GrepTool.inputSchema.parse({ pattern, ...extra })
	return GrepTool.execute(parsed, context)
}

describe('grep default mode lists files, newest first', () => {
	it('is files_with_matches, ordered by modification time', async () => {
		const { context } = workspace(
			{
				'old.txt': 'needle\n',
				'new.txt': 'needle\n',
				'mid.txt': 'needle\n',
				'none.txt': 'x\n',
			},
			{ 'old.txt': 1_000, 'mid.txt': 2_000, 'new.txt': 3_000 },
		)
		const result = await run(context)
		expect(result.success).toBe(true)
		expect(result.output).toBe(['Found 3 files', './new.txt', './mid.txt', './old.txt'].join('\n'))
	})

	it('breaks a tie by path', async () => {
		const { context } = workspace(
			{ 'b.txt': 'needle\n', 'a.txt': 'needle\n' },
			{ 'a.txt': 5_000, 'b.txt': 5_000 },
		)
		expect((await run(context)).output).toBe('Found 2 files\n./a.txt\n./b.txt')
	})

	it('says so when nothing matches', async () => {
		const { context } = workspace({ 'a.txt': 'x\n' })
		expect((await run(context)).output).toContain('No matches found')
	})
})

describe('grep content mode', () => {
	it('returns matching lines with path and line number', async () => {
		const { context } = workspace({ 'a.txt': 'x\nneedle one\ny\n' })
		const result = await run(context, { output_mode: 'content' })
		expect(result.output).toContain('./a.txt:2:needle one')
		expect(result.output).toContain('Found 1 match(es) in 1 file(s)')
	})

	it('replaces a line past the column cap with a notice', async () => {
		const long = `needle ${'z'.repeat(MAX_LINE_COLUMNS)}`
		const { context } = workspace({ 'min.js': `${long}\nneedle short\n` })
		const result = await run(context, { output_mode: 'content' })
		expect(result.output).toContain('./min.js:1:[Omitted long matching line]')
		expect(result.output).toContain('./min.js:2:needle short')
		expect(result.output).not.toContain('zzzz')
	})

	it('omits a long context line the same way', async () => {
		const { context } = workspace({ 'a.js': `${'q'.repeat(600)}\nneedle\n` })
		const result = await run(context, {
			output_mode: 'content',
			context_lines: 1,
		})
		expect(result.output).toContain('./a.js-1-[Omitted long context line]')
		expect(result.output).toContain('./a.js:2:needle')
	})
})

describe('grep count mode', () => {
	it('counts matching lines per file and in total', async () => {
		const { context } = workspace({
			'a.txt': 'needle\nneedle\n',
			'b.txt': 'needle\n',
		})
		const result = await run(context, { output_mode: 'count' })
		expect(result.output).toContain('./a.txt:2')
		expect(result.output).toContain('./b.txt:1')
		expect(result.output).toContain('Found 3 total matches across 2 files')
	})
})

describe('grep paging', () => {
	it('defaults to 250 entries', () => {
		expect(DEFAULT_HEAD_LIMIT).toBe(250)
	})

	it('limits and offsets a file list, and reports the page', async () => {
		const files: Record<string, string> = {}
		const times: Record<string, number> = {}
		for (let i = 0; i < 5; i++) {
			files[`f${i}.txt`] = 'needle\n'
			times[`f${i}.txt`] = 1_000 * (5 - i)
		}
		const { context } = workspace(files, times)
		const first = await run(context, { head_limit: 2 })
		expect(first.output).toBe('Found 2 files (limit: 2)\n./f0.txt\n./f1.txt')
		const second = await run(context, { head_limit: 2, offset: 2 })
		expect(second.output).toBe('Found 2 files (limit: 2, offset: 2)\n./f2.txt\n./f3.txt')
		const last = await run(context, { head_limit: 2, offset: 4 })
		expect(last.output).toBe('Found 1 file (offset: 4)\n./f4.txt')
		const past = await run(context, { head_limit: 2, offset: 9 })
		expect(past.output).toContain('No entries at this offset')
	})

	it('treats 0 as unlimited', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 300; i++) files[`f${i}.txt`] = 'needle\n'
		const { context } = workspace(files)
		expect((await run(context, { head_limit: 0 })).output.split('\n').length).toBe(301)
		const capped = await run(context)
		expect(capped.output.split('\n')[0]).toBe('Found 250 files (limit: 250)')
	})

	it('pages content by output line, and reports a full page as possibly continuing', async () => {
		const body = Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n')
		const { context } = workspace({ 'a.txt': body })
		const first = await run(context, { output_mode: 'content', head_limit: 3 })
		expect(first.output).toContain('./a.txt:1:needle 0')
		expect(first.output).toContain('./a.txt:3:needle 2')
		expect(first.output).not.toContain('needle 3')
		expect(first.output).toContain('more may follow')
		const next = await run(context, {
			output_mode: 'content',
			head_limit: 3,
			offset: 3,
		})
		expect(next.output).toContain('./a.txt:4:needle 3')
		expect(next.output).not.toContain('needle 2')
	})

	it('still honours max_results as the old name for the limit', async () => {
		const body = Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n')
		const { context } = workspace({ 'a.txt': body })
		const result = await run(context, {
			output_mode: 'content',
			max_results: 2,
		})
		expect(result.output).toContain('needle 1')
		expect(result.output).not.toContain('needle 2')
	})

	it('refuses a negative or fractional limit and offset', () => {
		expect(() => GrepTool.inputSchema.parse({ pattern: 'a', head_limit: -1 })).toThrow()
		expect(() => GrepTool.inputSchema.parse({ pattern: 'a', offset: 1.5 })).toThrow()
	})
})

describe('grep asymmetric context and matched substrings', () => {
	it('overrides each side independently without changing symmetric context defaults', async () => {
		const { context } = workspace({ 'a.txt': 'before2\nbefore1\nneedle\nafter1\nafter2\n' })
		const result = await run(context, {
			output_mode: 'content',
			context_lines: 2,
			before_context: 0,
			after_context: 1,
		})
		expect(result.output).toContain('./a.txt:3:needle')
		expect(result.output).toContain('./a.txt-4-after1')
		expect(result.output).not.toContain('before1')
		expect(result.output).not.toContain('after2')
	})

	it('prints every matched substring with its line, ignoring context', async () => {
		const { context } = workspace({
			'a.txt': 'surrounding\nprefix needle suffix needle tail\nafter\n',
		})
		const result = await run(context, {
			output_mode: 'content',
			only_matching: true,
			context_lines: 9,
		})
		expect(result.output.split('\n').filter((line) => line.startsWith('./'))).toEqual([
			'./a.txt:2:needle',
			'./a.txt:2:needle',
		])
		expect(result.output).not.toContain('prefix')
		expect(result.output).not.toContain('surrounding')
	})

	it('pages a dense match-only result and advances past empty regex matches', async () => {
		const { context } = workspace({ 'a.txt': 'needle needle needle' })
		const result = await run(context, {
			output_mode: 'content',
			only_matching: true,
			head_limit: 1,
			offset: 1,
		})
		expect(result.output.split('\n').filter((line) => line.startsWith('./'))).toEqual([
			'./a.txt:1:needle',
		])
		expect(result.data).toMatchObject({ truncated: true })
		const empty = await run(context, { output_mode: 'content', only_matching: true }, '(?:)')
		expect(empty.output).toContain('No matches found')
	})

	it('enforces the page cap while expanding a large context group', async () => {
		const { context } = workspace({ 'a.txt': `needle\n${'context\n'.repeat(1000)}` })
		const result = await run(context, {
			output_mode: 'content',
			after_context: 1000,
			head_limit: 2,
		})
		expect(result.output.split('\n').filter((line) => line.startsWith('./'))).toHaveLength(2)
		expect(result.data).toMatchObject({ truncated: true })
	})
})
