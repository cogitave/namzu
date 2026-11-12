import { describe, expect, it } from 'vitest'

import { EMPTY_GROUP, type FoldOp, foldOp, groupText } from '../read-search-group.js'
import { EXPAND_HINT } from '../truncation.js'
import type { TranscriptMessage } from '../types.js'
import { createLayoutCache, layoutTranscript } from './layout.js'
import type { FsRow } from './rows.js'

const CLICK = { click: true, open: new Set<string>() }
const openOf = (...ids: string[]) => ({ click: true, open: new Set(ids) })

const read = (key: string): FoldOp => ({ kind: 'read', key })
const run = (command: string): FoldOp => ({
	kind: 'run',
	command,
	cell: { header: `Bash(${command})`, shell: { stdout: ['ok'], stderr: [], failed: false } },
})

/** A settled group the way the log keeps it: the line, the hint, every call under it. */
function group(id: string, ops: readonly FoldOp[]): TranscriptMessage {
	const state = ops.reduce((acc, op) => foldOp(acc, op), EMPTY_GROUP)
	return {
		id,
		role: 'tool',
		content: groupText(state, false),
		glyph: ' ',
		activity: 'exploration',
		group: state,
		meta: EXPAND_HINT,
		detailRef: 1,
		detail: ['Read a.ts', 'alpha', 'beta', '', 'Bash(node --version)', 'v22'],
	}
}

/** A tool row whose output is longer than the preview. */
function longOutput(id: string, lines = 20): TranscriptMessage {
	return {
		id,
		role: 'tool',
		content: 'Bash(seq 20)',
		glyph: '●',
		detailRef: 2,
		detail: Array.from({ length: lines }, (_, i) => `line ${i + 1}`),
	}
}

const rows0 = (rows: readonly FsRow[]) => rows.map((row) => row.text).join('\n')
const texts = (rows: readonly FsRow[]) => rows.map((row) => row.text)
const layout = (
	messages: readonly TranscriptMessage[],
	view = CLICK,
	cache = createLayoutCache(),
	columns = 60,
) => layoutTranscript(messages, null, undefined, columns, cache, view)

describe('the rows a click opens', () => {
	it('keeps the hint as it is where a click is not the way', () => {
		const { rows } = layout([group('g', [read('a.ts'), run('node --version')])], {
			click: false,
			open: new Set(['g']),
		})
		expect(texts(rows)[0]).toContain(EXPAND_HINT)
		expect(rows.some((row) => row.opens)).toBe(false)
	})

	it('words the hint as a click and marks the line and the commands under a group', () => {
		const { rows } = layout([group('g', [read('a.ts'), run('node --version'), run('git status')])])
		expect(texts(rows)[0]).toContain('(click to expand)')
		expect(texts(rows)[0]).not.toContain('ctrl+o')
		expect(texts(rows).slice(1)).toEqual(['⎿  $ node --version', '   $ git status'])
		expect(rows.map((row) => row.opens === true)).toEqual([true, true, true])
	})

	it('marks a cut output by its line and its hint row, not by the text it shows', () => {
		const { rows } = layout([longOutput('t')])
		const marked = rows.filter((row) => row.opens).map((row) => row.text)
		expect(marked).toHaveLength(2)
		expect(marked[0]).toContain('Bash(seq 20)')
		expect(marked[1]).toContain('(click to expand)')
		expect(texts(rows).filter((t) => t.endsWith('line 1'))).toHaveLength(1)
	})

	it('draws an open row whole, names the way to fold it and answers on its line alone', () => {
		const closed = layout([longOutput('t')]).rows
		const { rows } = layout([longOutput('t')], openOf('t'))
		const shown = texts(rows)
		expect(shown.length).toBeGreaterThan(closed.length)
		expect(shown.some((t) => t.includes('line 12'))).toBe(true)
		expect(shown[0]).toContain('(click to fold)')
		expect(shown.join('\n')).not.toContain('to expand')
		expect(rows.filter((row) => row.opens)).toHaveLength(1)
	})

	it('opens a group to each call with its result, as the detailed transcript shows it', () => {
		const { rows } = layout([group('g', [read('a.ts'), run('node --version')])], openOf('g'))
		const shown = texts(rows).map((t) => t.trim())
		expect(shown[0]).toContain('(click to fold)')
		expect(shown).toEqual(
			expect.arrayContaining(['Read a.ts', 'alpha', 'beta', 'Bash(node --version)', 'v22']),
		)
		// The listed commands are what the open rows replace.
		expect(shown.some((t) => t.includes('$ node --version'))).toBe(false)
	})

	it('keeps a hint that is not the message own on a row that does not react', () => {
		const quoted: TranscriptMessage[] = [
			{ id: 'u', role: 'user', content: `press ${EXPAND_HINT} to open` },
			{ id: 'a', role: 'assistant', content: `the row says ${EXPAND_HINT}` },
			{ id: 's', role: 'system', content: 'Done.' },
			{ id: 't', role: 'tool', content: 'Bash(true)', detail: ['one', 'two'] },
		]
		const { rows } = layout(quoted)
		expect(rows.some((row) => row.opens)).toBe(false)
		expect(texts(rows).join('\n')).toContain(`press ${EXPAND_HINT} to open`)
	})

	it('opens a collapsed agent answer to its whole text', () => {
		const answer: TranscriptMessage = {
			id: 'a1',
			role: 'tool',
			content: 'Message from @counter',
			glyph: '›',
			activity: 'agent-result',
			meta: EXPAND_HINT,
			detail: ['first line of the answer', 'second line of the answer'],
		}
		const closed = layout([answer]).rows
		expect(texts(closed)).toEqual(['Message from @counter · (click to expand)'])
		expect(closed[0]?.opens).toBe(true)
		const open = layout([answer], openOf('a1')).rows
		expect(texts(open)[0]).toBe('Message from @counter · (click to fold)')
		expect(texts(open).map((t) => t.trim())).toEqual(
			expect.arrayContaining(['first line of the answer', 'second line of the answer']),
		)
	})

	it('ignores an open id whose row has nothing to open', () => {
		const plain: TranscriptMessage = { id: 's', role: 'system', content: 'Done.' }
		const open = layout([plain], openOf('s')).rows
		expect(texts(open)).toEqual(['Done.'])
	})

	it('finds the hint when the wrap breaks it across two rows', () => {
		const { rows } = layout([group('g', [read('a.ts')])], CLICK, createLayoutCache(), 22)
		expect(rows.length).toBeGreaterThan(1)
		expect(rows[0]?.opens).toBe(true)
	})
})

describe('what opening a row costs', () => {
	/** Messages laid out by the first pass, and by the pass after one is opened far up. */
	function costs(n: number): { first: number; after: number } {
		const messages: TranscriptMessage[] = Array.from({ length: n }, (_, i) =>
			i % 5 === 0 ? longOutput(`m${i}`) : { id: `m${i}`, role: 'system', content: `note ${i}` },
		)
		const cache = createLayoutCache()
		layout(messages, CLICK, cache)
		const first = cache.laid
		layout(messages, CLICK, cache)
		expect(cache.laid).toBe(first)
		layout(messages, openOf('m0'), cache)
		return { first, after: cache.laid - first }
	}

	it('lays out one message when one is opened, however long the conversation is', () => {
		const small = costs(40)
		const large = costs(160)
		expect(small.first).toBe(40)
		expect(large.first).toBe(160)
		expect(small.after).toBe(1)
		expect(large.after).toBe(1)
	})

	it('lays a message out again when it changes while open, and only that one', () => {
		const a = longOutput('a')
		const b = longOutput('b')
		const cache = createLayoutCache()
		const before = layout([a, b], openOf('a'), cache)
		const laid = cache.laid
		const grown = { ...a, detail: [...(a.detail ?? []), 'a late line'] }
		const after = layout([grown, b], openOf('a'), cache)
		expect(cache.laid - laid).toBe(1)
		expect(after.rows.length).toBe(before.rows.length + 1)
		expect(texts(after.rows).some((t) => t.endsWith('a late line'))).toBe(true)
	})

	it('lays out again for another width, with the open state kept', () => {
		const cache = createLayoutCache()
		layout([longOutput('t')], openOf('t'), cache, 60)
		const narrow = layout([longOutput('t')], openOf('t'), cache, 30)
		expect(texts(narrow.rows).slice(0, 2).join(' ')).toContain('(click to fold)')
		expect(narrow.rows.filter((row) => row.opens).length).toBeGreaterThan(0)
	})

	it("shows a command's own output as it printed it, quoted hint included", () => {
		const quote = 'tip: press (ctrl+o to expand) for more'
		const m: TranscriptMessage = {
			...longOutput('q'),
			detail: [quote, ...Array.from({ length: 19 }, (_, i) => `line ${i + 2}`)],
		}
		const { rows } = layout([m])
		expect(texts(rows).some((t) => t.includes(quote))).toBe(true)
		// Only the hint's own row says "click".
		expect(texts(rows).filter((t) => t.includes('(click to expand)'))).toHaveLength(1)
	})

	it('does not answer a click on a row with nothing folded, whatever its text says', () => {
		const m: TranscriptMessage = {
			id: 'n',
			role: 'tool',
			content: 'Bash(echo)',
			glyph: '●',
			detailRef: 3,
			detail: ['or (click to expand)', 'tip: (ctrl+o to expand)'],
		}
		const { rows } = layout([m])
		expect(texts(rows).join('\n')).toContain('tip: (ctrl+o to expand)')
		expect(rows.some((row) => row.opens)).toBe(false)
	})

	it('keeps a quoted hint in a meta that does not end in the hint', () => {
		const m: TranscriptMessage = {
			...longOutput('m'),
			meta: `says ${EXPAND_HINT} twice`,
		}
		expect(rows0(layout([m]).rows)).toContain(`says ${EXPAND_HINT} twice`)
	})
})
