import { describe, expect, it } from 'vitest'

import { EMPTY_GROUP, type FoldOp, foldOp, groupText } from '../read-search-group.js'
import type { TranscriptMessage } from '../types.js'
import { MARK_ID, createLayoutCache, layoutTranscript } from './layout.js'
import { findMatches } from './search.js'
import { selectedText } from './selection.js'

function message(i: number, content = `reply ${i}`): TranscriptMessage {
	return { id: `m${i}`, role: 'assistant', content }
}

describe('laying the transcript out for the viewport', () => {
	it('indexes each message by the rows it took, separator included', () => {
		const messages = [message(0), message(1, 'a\n\nb\n\nc')]
		const { rows, index } = layoutTranscript(messages, null, undefined, 40, createLayoutCache())
		expect(index.ids).toEqual(['m0', 'm1'])
		expect(index.starts).toEqual([0, 1])
		expect(index.total).toBe(rows.length)
		// Three paragraphs and the blank row between each pair.
		expect(rows).toHaveLength(1 + 1 + 5)
	})

	it('keeps the meta suffix of a reply that carries one', () => {
		const { rows } = layoutTranscript(
			[{ ...message(0, 'hello'), meta: 'two seconds' }],
			null,
			undefined,
			40,
			createLayoutCache(),
		)
		expect(rows.map((row) => row.text).join('\n')).toContain('hello · two seconds')
	})

	it('puts the streaming reply where it stands in the conversation', () => {
		const pending = { ...message(9, 'streaming'), pending: true }
		const { index } = layoutTranscript(
			[message(0), message(1)],
			pending,
			1,
			40,
			createLayoutCache(),
		)
		expect(index.ids).toEqual(['m0', 'm9', 'm1'])
	})

	it('lays a message out again only when its width changes', () => {
		const cache = createLayoutCache()
		const messages = [message(0, 'x'.repeat(100))]
		const wide = layoutTranscript(messages, null, undefined, 120, cache)
		const same = layoutTranscript(messages, null, undefined, 120, cache)
		expect(same.rows[0]).toBe(wide.rows[0])
		const narrow = layoutTranscript(messages, null, undefined, 30, cache)
		expect(narrow.index.total).toBeGreaterThan(wide.index.total)
	})

	it('lists the commands a group folded under its line, as the live view does', () => {
		const run = (command: string): FoldOp => ({
			kind: 'run',
			command,
			cell: {
				header: `Bash(${command})`,
				shell: { stdout: ['ok'], stderr: [], failed: false },
			},
		})
		const group = ['node --version', 'git --version'].reduce(
			(state, command) => foldOp(state, run(command)),
			EMPTY_GROUP,
		)
		const grouped: TranscriptMessage = {
			id: 'g',
			role: 'tool',
			content: groupText(group, false),
			group,
		}
		const texts = layoutTranscript([grouped], null, undefined, 60, createLayoutCache()).rows.map(
			(row) => row.text,
		)
		expect(texts[0]).toContain('Ran 2 commands')
		expect(texts.slice(1)).toEqual(['⎿  $ node --version', '   $ git --version'])
		const one = foldOp(EMPTY_GROUP, run('node --version'))
		const alone = layoutTranscript(
			[{ ...grouped, group: one, content: groupText(one, false) }],
			null,
			undefined,
			60,
			createLayoutCache(),
		)
		expect(alone.rows.map((row) => row.text)).toEqual(['Ran 1 command'])
	})
})

describe('the rule where the new replies begin', () => {
	const messages = [message(0), message(1), message(2), message(3)]
	const plain = layoutTranscript(messages, null, undefined, 40, createLayoutCache())
	const marked = layoutTranscript(messages, null, undefined, 40, createLayoutCache(), undefined, {
		before: 'm2',
		count: 2,
	})

	it('is one row, an entry of its own in the index, above the first unseen reply', () => {
		expect(marked.rows).toHaveLength(plain.rows.length + 1)
		expect(marked.index.ids).toEqual(['m0', 'm1', MARK_ID, 'm2', 'm3'])
		const at = marked.index.starts[2] ?? -1
		expect(marked.rows[at]?.mark).toContain('2 new replies')
		expect(marked.rows[at]?.text).toBe('')
	})

	it('leaves every message at the same place inside its own rows', () => {
		for (const id of ['m0', 'm1']) {
			expect(marked.index.starts[marked.index.ids.indexOf(id)]).toBe(
				plain.index.starts[plain.index.ids.indexOf(id)],
			)
		}
		expect(marked.index.tail).toBe(plain.index.tail)
	})

	it('has no text for a search to find or a copy to take', () => {
		expect(findMatches(marked.rows, 'new replies')).toEqual([])
		const all = selectedText(marked.rows, 38, {
			anchor: { line: 0, col: 0 },
			focus: { line: marked.rows.length - 1, col: 37 },
			mode: 'char',
		})
		expect(all).not.toContain('new replies')
		expect(all).not.toContain('─')
		expect(all).toContain('reply 1')
		expect(all).toContain('reply 2')
	})

	it('is not drawn above the very first message, where nothing came before', () => {
		const first = layoutTranscript(messages, null, undefined, 40, createLayoutCache(), undefined, {
			before: 'm0',
			count: 1,
		})
		expect(first.rows).toHaveLength(plain.rows.length)
	})
})
