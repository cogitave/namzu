import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type HistoryWorkSnapshot, restoreHistoryWork } from '../shared/history-work.js'
import { emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { ChangesPanel } from './changes-panel.js'
import { Transcript } from './transcript.js'
import { TurnChangesCard } from './turn-changes-card.js'
import { turnChanges } from './turn-changes.js'

const diff = (path: string, before: string, after: string) => ({
	kind: 'diff' as const,
	path,
	before,
	after,
})
const rows: ChatMessage[] = [
	{ role: 'user', text: 'one' },
	{ role: 'assistant', text: 'first reply' },
	{ role: 'user', text: 'two' },
	{ role: 'assistant', text: 'second reply' },
	{ role: 'user', text: 'three' },
	{ role: 'assistant', text: 'third reply' },
]
const anchors = [
	['u1', 't1', 2],
	['a1', 't1', 7],
	['u2', 't2', 12],
	['a2', 't2', 17],
	['u3', 't3', 22],
	['a3', 't3', 23],
] as const
const work: HistoryWorkSnapshot = {
	v: 1,
	partial: false,
	messages: anchors.map(([messageId, turnId, order], index) => ({
		index,
		messageId,
		turnId,
		order,
	})),
	turns: ['t1', 't2', 't3'].map((turnId, index) => ({
		turnId,
		userMessageId: `u${index + 1}`,
		order: index * 10 + 1,
		status: 'completed' as const,
		reason: 'end_turn',
	})),
	tools: [
		{
			turnId: 't1',
			toolUseId: 'a',
			name: 'write',
			order: 3,
			status: 'completed',
			presentation: diff('src/one.css', 'a\n', 'a\nb\n'),
		},
		{
			turnId: 't1',
			toolUseId: 'b',
			name: 'write',
			order: 4,
			status: 'completed',
			presentation: diff('src/one.css', 'a\nb\n', 'a\nb\nc\nd\n'),
		},
		{
			turnId: 't2',
			toolUseId: 'c',
			name: 'write',
			order: 13,
			status: 'completed',
			presentation: diff('src/two.css', 'x\ny\n', 'x\n'),
		},
		{
			turnId: 't2',
			toolUseId: 'd',
			name: 'write',
			order: 14,
			status: 'completed',
			presentation: diff('src/three.ts', '', 'one\ntwo\nthree\n'),
		},
		{
			turnId: 't2',
			toolUseId: 'e',
			name: 'write',
			order: 15,
			status: 'completed',
			presentation: diff('src/same.ts', 'keep\n', 'keep\n'),
		},
		{
			turnId: 't3',
			toolUseId: 'f',
			name: 'write',
			order: 24,
			status: 'failed',
			presentation: diff('src/failed.ts', 'a\n', 'b\n'),
		},
	],
}
const thread = restoreHistoryWork(emptyThread(), rows, work)

describe('per-reply edit summary', () => {
	it('groups completed edits by the turn that made them, including restored history', () => {
		const changes = turnChanges(thread)
		expect([...changes.keys()]).toEqual([1, 2])
		expect(changes.get(1)?.receiptIds).toEqual(['1:a', '1:b'])
		expect(changes.get(2)?.receiptIds).toEqual(['2:c', '2:d'])
	})

	it('totals a file once across its edits and leaves out files that end unchanged', () => {
		const changes = turnChanges(thread)
		expect(changes.get(1)).toMatchObject({ added: 3, removed: 0 })
		expect(changes.get(1)?.files).toHaveLength(1)
		expect(changes.get(1)?.files[0]).toMatchObject({ name: 'one.css', path: 'src/one.css' })
		expect(changes.get(2)).toMatchObject({ added: 3, removed: 1 })
		expect(changes.get(2)?.files.map((file) => [file.name, file.added, file.removed])).toEqual([
			['two.css', 0, 1],
			['three.ts', 3, 0],
		])
	})

	it('names one file by its basename with the full path in the tooltip', () => {
		const html = renderToStaticMarkup(
			createElement(TurnChangesCard, {
				changes: turnChanges(thread).get(1) as never,
				onOpen: () => {},
			}),
		)
		expect(html).toContain('Edited ')
		expect(html).toContain('<strong>one.css</strong>')
		expect(html).toContain('title="src/one.css"')
		expect(html).toContain('View changes')
		expect(html).not.toContain('Undo')
	})

	it('summarises several files as a count that expands to per-file totals', () => {
		const html = renderToStaticMarkup(
			createElement(TurnChangesCard, {
				changes: turnChanges(thread).get(2) as never,
				onOpen: () => {},
			}),
		)
		expect(html).toContain('<strong>2 files</strong>')
		expect(html).toContain('aria-expanded="false"')
		expect(html).not.toContain('turn-changes-files')
	})

	it('places the card after its own reply and never in a turn without edits', () => {
		const html = renderToStaticMarkup(
			createElement(Transcript, { thread, onOpenTurnChanges: () => {} }),
		)
		expect(html.match(/data-turn-changes="/g)).toHaveLength(2)
		expect(html.indexOf('first reply')).toBeLessThan(html.indexOf('data-turn-changes="1"'))
		expect(html.indexOf('data-turn-changes="1"')).toBeLessThan(html.indexOf('second reply'))
		expect(html.indexOf('second reply')).toBeLessThan(html.indexOf('data-turn-changes="2"'))
		expect(html.indexOf('data-turn-changes="2"')).toBeLessThan(html.indexOf('third reply'))
		expect(renderToStaticMarkup(createElement(Transcript, { thread }))).not.toContain(
			'data-turn-changes',
		)
	})

	it('filters the drawer to one reply and returns to all of them', () => {
		const render = (receiptIds?: string[]) =>
			renderToStaticMarkup(
				createElement(ChangesPanel, {
					tools: thread.tools,
					dark: false,
					receiptIds,
					onShowAll: () => {},
				}),
			)
		const filtered = render(['2:c', '2:d'])
		expect(filtered).toContain('Showing selected changes')
		expect(filtered).toContain('Show all')
		expect(filtered).toContain('2 file changes')
		const all = render(undefined)
		expect(all).not.toContain('Showing selected changes')
		expect(all).toContain('5 file changes')
	})
})
