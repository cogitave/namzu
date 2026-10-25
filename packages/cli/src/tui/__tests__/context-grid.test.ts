import type { ContextBreakdown, ContextCategory } from '@namzu/sdk'
import { analyzeContextUsage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	GLYPH_BUFFER,
	GLYPH_FREE,
	GLYPH_FULL,
	GLYPH_PARTIAL,
	buildContextView,
	buildGridCells,
	buildLegend,
	buildSuggestions,
	formatSkillTokens,
	formatTokens,
	gridShape,
} from '../context-grid.js'

const cat = (
	id: ContextCategory['id'],
	tokens: number,
	kind: ContextCategory['kind'] = 'used',
	name = id,
): ContextCategory => ({ id, name, tokens, kind })

const flat = (cells: ReturnType<typeof buildGridCells>) => cells.flat()

describe('the grid', () => {
	it('is 10 by 10, 5 by 5 under 80 columns, and 20 by 10 for a million-token window', () => {
		expect(gridShape(200_000, 80)).toEqual({ columns: 10, rows: 10 })
		expect(gridShape(200_000, 79)).toEqual({ columns: 5, rows: 5 })
		expect(gridShape(1_000_000, 120)).toEqual({ columns: 20, rows: 10 })
		const cats = [cat('messages', 1_000), cat('free', 199_000, 'free')]
		expect(flat(buildGridCells(cats, 200_000, 80))).toHaveLength(100)
		expect(flat(buildGridCells(cats, 200_000, 60))).toHaveLength(25)
		expect(flat(buildGridCells(cats, 1_000_000, 120))).toHaveLength(200)
	})

	it('gives a tiny category one square', () => {
		const cells = flat(
			buildGridCells([cat('memory', 800), cat('free', 199_200, 'free')], 200_000, 80),
		)
		expect(cells.filter((c) => c.glyph !== GLYPH_FREE)).toHaveLength(1)
	})

	it('draws a square full from 70% and partly filled below it', () => {
		// 100 cells over 200k tokens: 2,000 tokens a square.
		const at = (tokens: number) =>
			flat(
				buildGridCells(
					[cat('messages', tokens), cat('free', 200_000 - tokens, 'free')],
					200_000,
					80,
				),
			).filter((c) => c.glyph !== GLYPH_FREE)
		const seventy = at(5_400) // 2.7 squares: rounds to 3, the last 0.7 full
		expect(seventy.map((c) => c.glyph)).toEqual([GLYPH_FULL, GLYPH_FULL, GLYPH_FULL])
		const sixty = at(5_200) // 2.6 squares: the last is 0.6 full
		expect(sixty.map((c) => c.glyph)).toEqual([GLYPH_FULL, GLYPH_FULL, GLYPH_PARTIAL])
	})

	it('fills free space before the buffer, and the buffer comes last', () => {
		const cells = flat(
			buildGridCells(
				[cat('messages', 40_000), cat('buffer', 33_000, 'buffer'), cat('free', 127_000, 'free')],
				200_000,
				80,
			),
		)
		const glyphs = cells.map((c) => c.glyph)
		expect(glyphs.indexOf(GLYPH_BUFFER)).toBeGreaterThan(glyphs.lastIndexOf(GLYPH_FREE))
		expect(glyphs.filter((g) => g === GLYPH_BUFFER)).toHaveLength(Math.round(0.165 * 100))
	})
})

describe('formatting', () => {
	it('abbreviates tokens', () => {
		expect(formatTokens(999)).toBe('999')
		expect(formatTokens(1_234)).toBe('1.2k')
		expect(formatTokens(42_000)).toBe('42k')
		expect(formatTokens(1_000_000)).toBe('1m')
	})
	it('rounds a skill to ten, or says under 20', () => {
		expect(formatSkillTokens(19)).toBe('< 20')
		expect(formatSkillTokens(34)).toBe('~30')
		expect(formatSkillTokens(1_240)).toBe('~1.2k')
	})
})

const view = (breakdown: ContextBreakdown, over = {}) =>
	buildContextView({
		breakdown,
		windowSource: 'auto',
		autoCompact: true,
		approximate: false,
		terminalColumns: 100,
		sections: [],
		memoryFiles: [],
		...over,
	})

describe('the legend and header', () => {
	const breakdown = analyzeContextUsage({
		windowTokens: 200_000,
		windowSource: 'auto',
		autoCompact: true,
		contextTokens: 42_000,
		systemPromptTokens: 4_000,
	})

	it('writes 42k/200k tokens (21%)', () => {
		expect(view(breakdown).usage).toBe('42k/200k tokens (21%)')
		expect(view(breakdown, { approximate: true }).usage).toBe('~42k/200k tokens (21%)')
	})

	it('lists each category with one decimal, then free space', () => {
		const lines = buildLegend(breakdown).map((l) => `${l.glyph} ${l.name}: ${l.value}`)
		expect(lines).toEqual([
			'⛁ System prompt: 4k tokens (2.0%)',
			'⛁ Messages: 38k tokens (19.0%)',
			'⛶ Free space: 158k (79.0%)',
		])
	})

	it('names the compaction window only when it was overridden', () => {
		expect(view(breakdown).windowNote).toBeUndefined()
		const set = analyzeContextUsage({
			windowTokens: 200_000,
			windowSource: 'config',
			autoCompact: true,
			contextTokens: 1_000,
		})
		expect(view(set, { windowSource: 'config' }).windowNote?.value).toBe('200,000 tokens')
		expect(buildLegend(set).at(-1)?.name).toBe('Autocompact buffer')
		expect(view(set, { windowSource: 'default' }).windowNote?.value).toContain(
			'default for an unrecognized model',
		)
	})

	it('draws the manual-compaction room as an ordinary line', () => {
		const off = analyzeContextUsage({
			windowTokens: 200_000,
			windowSource: 'auto',
			autoCompact: false,
			contextTokens: 1_000,
		})
		const lines = buildLegend(off)
		expect(lines.map((l) => `${l.glyph} ${l.name}`)).toEqual([
			'⛁ Messages',
			'⛁ Compact buffer',
			'⛶ Free space',
		])
	})

	it('says the context is over the limit, once', () => {
		const over = analyzeContextUsage({
			windowTokens: 100_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 120_000,
		})
		expect(view(over).overLimit).toBe(
			'Context exceeds the 100k-token limit by 20k tokens — run /compact or /clear to continue.',
		)
		expect(view(over, { windowSource: 'config' }).overLimit).toContain(
			'20k tokens past the 100k-token compaction window',
		)
	})
})

describe('advice', () => {
	const messagesWith = (toolResults: Record<string, number>, percent: number) => {
		const window = 100_000
		const base = analyzeContextUsage({
			windowTokens: window,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: Math.round(window * (percent / 100)),
		})
		return {
			...base,
			messageBreakdown: {
				toolCallsByType: {},
				toolResultsByType: toolResults,
				assistantTokens: 0,
				userTokens: 0,
			},
		} satisfies ContextBreakdown
	}
	const titles = (breakdown: ContextBreakdown, autoCompact = true) =>
		buildSuggestions({ breakdown, autoCompact, memoryFiles: [] }).map((s) => s.title)

	it('warns at 80% full and not at 79%', () => {
		expect(titles(messagesWith({}, 79))).toEqual([])
		expect(titles(messagesWith({}, 80))).toEqual(['Context is 80% full'])
	})

	it('flags a tool at 15% of the window and 10,000 tokens, not below either', () => {
		expect(titles(messagesWith({ bash: 15_000 }, 20))[0]).toContain('bash results using')
		expect(titles(messagesWith({ bash: 14_999 }, 20))).toEqual([])
		const small = { ...messagesWith({ bash: 9_999 }, 20), windowTokens: 50_000 }
		expect(titles(small)).toEqual([])
	})

	it('flags file reads at 5% only when no tool rule fired, and needs 10,000 tokens', () => {
		const big = analyzeContextUsage({
			windowTokens: 1_000_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 200_000,
		})
		const withReads = (tokens: number) => ({
			...big,
			messageBreakdown: {
				toolCallsByType: {},
				toolResultsByType: { read: tokens },
				assistantTokens: 0,
				userTokens: 0,
			},
		})
		expect(titles(withReads(50_000))[0]).toContain('File reads using')
		expect(titles(withReads(49_999))).toEqual([])
		expect(titles(withReads(9_999))).toEqual([])
	})

	it('still flags file reads when another tool fired but the read tool alone is under 15%', () => {
		const big = analyzeContextUsage({
			windowTokens: 1_000_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 400_000,
		})
		const mixed = {
			...big,
			messageBreakdown: {
				toolCallsByType: {},
				toolResultsByType: { bash: 200_000, read: 60_000 },
				assistantTokens: 0,
				userTokens: 0,
			},
		}
		expect(titles(mixed)).toEqual([
			'bash results using 200k tokens (20%)',
			'File reads using 60k tokens (6%)',
		])
		const readHeavy = {
			...mixed,
			messageBreakdown: { ...mixed.messageBreakdown, toolResultsByType: { read: 150_000 } },
		}
		expect(titles(readHeavy)).toEqual(['read results using 150k tokens (15%)'])
	})

	it('flags memory files at 5% and 5,000 tokens, naming the largest three', () => {
		const breakdown = analyzeContextUsage({
			windowTokens: 100_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 30_000,
			memoryTokens: 5_000,
		})
		const out = buildSuggestions({
			breakdown,
			autoCompact: true,
			memoryFiles: [
				{ label: 'AGENTS.md', tokens: 3_000 },
				{ label: 'docs/a.md', tokens: 1_500 },
				{ label: 'b.md', tokens: 400 },
				{ label: 'c.md', tokens: 100 },
			],
		})
		expect(out[0]?.detail).toContain('Largest: AGENTS.md (3k), docs/a.md (1.5k), b.md (400)')
		const low = analyzeContextUsage({
			windowTokens: 100_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 30_000,
			memoryTokens: 4_999,
		})
		expect(buildSuggestions({ breakdown: low, autoCompact: true, memoryFiles: [] })).toEqual([])
	})

	it('puts warnings first and then the larger saving', () => {
		const breakdown = messagesWith({ read: 30_000, bash: 20_000 }, 85)
		const out = buildSuggestions({ breakdown, autoCompact: true, memoryFiles: [] })
		expect(out.map((s) => s.level)).toEqual(['warning', 'warning', 'info'])
		expect(out[0]?.title).toContain('bash')
		expect(out[1]?.title).toBe('Context is 85% full')
	})

	it('says nothing once the context no longer fits', () => {
		const over = analyzeContextUsage({
			windowTokens: 100_000,
			windowSource: 'auto',
			autoCompact: true,
			contextTokens: 150_000,
		})
		expect(buildSuggestions({ breakdown: over, autoCompact: true, memoryFiles: [] })).toEqual([])
	})

	it('mentions auto-compact off between 50% and 80%', () => {
		const out = buildSuggestions({
			breakdown: messagesWith({}, 60),
			autoCompact: false,
			memoryFiles: [],
		})
		expect(out.map((s) => s.title)).toEqual(['Autocompact is disabled'])
	})
})
