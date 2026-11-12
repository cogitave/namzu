import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLayoutCache, layoutTranscript } from '../fullscreen/layout.js'
import { EMPTY_GROUP, type FoldOp, foldOp } from '../read-search-group.js'
import { PALETTES, THEME_NAMES } from '../theme-palettes.js'
import { applyPalette, drawsTint, rowTints } from '../theme.js'
import { interruptedCallHeads } from '../tool-end-rows.js'
import { transcriptScrollRows } from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'

afterEach(() => {
	vi.unstubAllEnvs()
	applyPalette('dark')
})

const person: TranscriptMessage = { id: 'u', role: 'user', content: 'fix the build please' }

function lay(messages: readonly TranscriptMessage[], columns = 60) {
	return layoutTranscript(messages, null, undefined, columns, createLayoutCache()).rows
}

describe('the person’s own message sits on a quiet tint', () => {
	it('draws a tint on a terminal with colour, and none where colour is refused', () => {
		const colour = { TERM: 'xterm-256color' }
		expect(drawsTint(colour)).toBe(true)
		expect(drawsTint({ COLORTERM: 'truecolor' })).toBe(true)
		expect(drawsTint({ ...colour, NO_COLOR: '1' })).toBe(false)
		expect(drawsTint({ ...colour, FORCE_COLOR: '0' })).toBe(false)
		expect(drawsTint({ TERM: 'dumb' })).toBe(false)
		// A CI run that did not force colour, and a terminal of 16 colours or fewer.
		expect(drawsTint({ ...colour, CI: 'true' })).toBe(false)
		expect(drawsTint({ TERM: 'xterm' })).toBe(false)
		expect(drawsTint({ TERM: 'linux' })).toBe(false)
	})

	it('reads on every palette: dark tints are dark, light tints are light, named-colour palettes paint none', () => {
		const luminance = (rgb: string) => {
			const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(rgb)
			if (!m) throw new Error(`not rgb: ${rgb}`)
			return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
		}
		for (const name of THEME_NAMES) {
			const { tint } = PALETTES[name]
			if (name.endsWith('-ansi')) {
				expect(tint).toEqual({ user: '', queued: '' })
				continue
			}
			for (const value of [tint.user, tint.queued]) {
				if (name.startsWith('dark')) expect(luminance(value)).toBeLessThan(0.2)
				else expect(luminance(value)).toBeGreaterThan(0.8)
			}
			// The queued message is the greyer one: less hue than the sent one.
			const spread = (rgb: string) => {
				const n = rgb.match(/\d+/g)?.map(Number) ?? []
				return Math.max(...n) - Math.min(...n)
			}
			expect(spread(tint.queued)).toBeLessThanOrEqual(spread(tint.user))
		}
	})

	it('puts the tint on the row, never in its text, so a copy carries no blanks', () => {
		vi.stubEnv('NO_COLOR', '')
		vi.stubEnv('CI', '')
		vi.stubEnv('FORCE_COLOR', '')
		vi.stubEnv('TERM', 'xterm-256color')
		expect(rowTints()).not.toBeNull()
		const rows = lay([person, { id: 'a', role: 'assistant', content: 'ok' }], 20)
		const mine = rows.filter((row) => row.glyph === '›' || (row.tint !== undefined && row.text))
		expect(mine.length).toBeGreaterThan(1)
		for (const row of mine) {
			expect(row.tint).toBe(PALETTES.dark.tint.user)
			// Exactly the words: no padding out to the edge.
			expect(row.text).toBe(row.text.trimEnd())
		}
		expect(mine.map((row) => row.text).join(' ')).toBe('fix the build please')
		// The reply under it carries none.
		expect(rows.at(-1)?.tint).toBeUndefined()
	})

	it('looks as it always did with no colour', () => {
		vi.stubEnv('NO_COLOR', '1')
		expect(rowTints()).toBeNull()
		expect(lay([person]).every((row) => row.tint === undefined)).toBe(true)
		expect(
			transcriptScrollRows([person], null, undefined, 40).every((r) => r.tint === undefined),
		).toBe(true)
	})
})

describe('a call the person interrupts keeps its header row', () => {
	it('names the calls that were running, in order, and none that only asked or folded', () => {
		const heads = interruptedCallHeads([
			{ label: 'Bash(sleep 20; echo finished)' },
			{ label: 'Update(a.txt)', queued: true },
			{ label: 'Read(a.txt)', fold: { kind: 'read' } },
			{ label: 'Waiting · Survey', waitingOn: 'Survey' },
			{ label: 'Bash(ls)' },
		])
		expect(heads.map((row) => [row.glyph, row.content])).toEqual([
			['●', 'Bash(sleep 20; echo finished)'],
			['●', 'Bash(ls)'],
		])
	})
})

describe('a result line sits in the same column in the fullscreen view as in the default one', () => {
	const result: TranscriptMessage = {
		id: 'r',
		role: 'system',
		content: 'Interrupted · The command continues in the background',
		glyph: '⎿',
	}

	it('hangs the mark and its words after the two-cell gutter, as the default screen does', () => {
		const rows = lay([{ id: 'h', role: 'tool', content: 'Bash(sleep 20)', glyph: '●' }, result], 80)
		const line = rows.at(-1)
		// Gutter of two, then the mark: the mark is at column 2, the words at column 5.
		expect(line?.glyph).toBe(' ')
		expect(line?.text).toBe('⎿  Interrupted · The command continues in the background')
	})

	it('hangs the rows of a wrapped result under its words and joins them back when copied', () => {
		const rows = lay([result], 24)
		const body = rows.filter((row) => row.text.trim() !== '')
		expect(body.length).toBeGreaterThan(1)
		expect(body[0]?.text.startsWith('⎿  ')).toBe(true)
		for (const row of body.slice(1)) {
			expect(row.text.startsWith('   ')).toBe(true)
			expect(row.lead).toBe(3)
			expect(row.joins).not.toBeNull()
		}
		for (const row of body) expect([...row.text].length).toBeLessThanOrEqual(24 - 2)
	})
})

describe('an open group of reads and searches in the fullscreen view', () => {
	const open = (ops: readonly FoldOp[]): TranscriptMessage => {
		const group = ops.reduce((state, op) => foldOp(state, op), EMPTY_GROUP)
		return {
			id: 'g',
			role: 'tool',
			content: 'Searching for 1 pattern, reading 2 files…',
			glyph: ' ',
			pending: true,
			activity: 'exploration',
			group,
		}
	}

	it('says how to open it, and shows the newest item under the line', () => {
		const rows = lay(
			[
				open([
					{ kind: 'read', key: 'a.txt', hint: 'a.txt' },
					{ kind: 'search', hint: '"needle"' },
				]),
			],
			80,
		)
		const text = rows.map((row) => row.text).join('\n')
		expect(text).toContain('(ctrl+o to expand)')
		expect(text).toContain('⎿  "needle"')
		expect(text).not.toContain('a.txt')
	})

	it('words the hint as a click where the pointer is reported', () => {
		const { rows } = layoutTranscript(
			[open([{ kind: 'read', key: 'a.txt', hint: 'a.txt' }])],
			null,
			undefined,
			80,
			createLayoutCache(),
			{ click: true, open: new Set() },
		)
		expect(rows.map((row) => row.text).join('\n')).toContain('(click to expand)')
	})
})
