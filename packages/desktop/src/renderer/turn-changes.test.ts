import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type HistoryWorkSnapshot, restoreHistoryWork } from '../shared/history-work.js'
import { emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { ChangesPanel } from './changes-panel.js'
import { Transcript } from './transcript.js'
import { turnChanges } from './turn-changes.js'
import { TurnResultLine } from './turn-result-line.js'
import { turnResultModel } from './turn-result-model.js'

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
		expect(changes.get(1)?.files[0]).toMatchObject({
			name: 'one.css',
			path: 'src/one.css',
		})
		expect(changes.get(2)).toMatchObject({ added: 3, removed: 1 })
		expect(changes.get(2)?.files.map((file) => [file.name, file.added, file.removed])).toEqual([
			['two.css', 0, 1],
			['three.ts', 3, 0],
		])
	})

	const line = (turn: number) => {
		const changes = turnChanges(thread).get(turn)
		const model = turnResultModel({ reason: 'end_turn', durationMs: 3000, changes })
		if (!changes || !model) throw new Error('no result line')
		return renderToStaticMarkup(
			createElement(TurnResultLine, { model, changes, onOpen: () => {}, onOpenFile: () => {} }),
		)
	}

	it('says how the turn ended, its size, and opens the changes from the whole row', () => {
		const html = line(1)
		expect(html).toContain('Done in 3s')
		expect(html).toContain('1 file')
		expect(html).toContain('aria-label="Done in 3s, 1 file changed, ')
		expect(html).toContain('. Open changes"')
		expect(html).toContain('aria-label="More about this reply"')
		expect(html).not.toContain('View changes')
		expect(html).not.toContain('data-undo=')
	})

	it('counts several files in one line instead of a list to expand', () => {
		const html = line(2)
		expect(html).toContain('2 files')
		expect(html).not.toContain('aria-expanded')
		expect(html).not.toContain('turn-changes-files')
	})

	it('places the line after its own reply and never in a turn without edits', () => {
		const html = renderToStaticMarkup(
			createElement(Transcript, { thread, onOpenTurnChanges: () => {} }),
		)
		expect(html.match(/data-turn-result="/g)).toHaveLength(2)
		expect(html.indexOf('first reply')).toBeLessThan(html.indexOf('data-turn-result="1"'))
		expect(html.indexOf('data-turn-result="1"')).toBeLessThan(html.indexOf('second reply'))
		expect(html.indexOf('second reply')).toBeLessThan(html.indexOf('data-turn-result="2"'))
		expect(html.indexOf('data-turn-result="2"')).toBeLessThan(html.indexOf('third reply'))
		expect(renderToStaticMarkup(createElement(Transcript, { thread }))).not.toContain(
			'data-turn-result',
		)
	})

	it('opens on all changes, with this reply one click away, whichever reply it came from', () => {
		const render = (receiptIds?: string[]) =>
			renderToStaticMarkup(
				createElement(ChangesPanel, {
					tools: thread.tools,
					timeline: thread.timeline,
					dark: false,
					receiptIds,
					onShowAll: () => {},
					onClose: () => {},
				}),
			)
		const fromReply = render(['2:c', '2:d'])
		const all = render(undefined)
		for (const html of [fromReply, all]) {
			expect(html).toMatch(/aria-pressed="true"[^>]*>All changes</)
			expect(html).toMatch(/aria-pressed="false"[^>]*>This reply</)
			// The whole conversation's total, not the reply's.
			expect(html).toContain('+6')
		}
	})

	it('has one header row: title, scope, counts, View, close, and nothing else', () => {
		const html = renderToStaticMarkup(
			createElement(ChangesPanel, {
				tools: thread.tools,
				timeline: thread.timeline,
				dark: false,
				onClose: () => {},
			}),
		)
		const bar = html.slice(
			html.indexOf('class="changes-bar"'),
			html.indexOf('class="changes-body"'),
		)
		expect(bar).toContain('>Changes</h2>')
		expect(bar).toContain('aria-label="View options"')
		expect(bar).toContain('aria-label="Close changes"')
		expect(bar).not.toContain('Activity')
		expect(bar).not.toContain('Add a tab')
		expect(bar).not.toContain('Wrap diff lines')
		// The files sit beside the diff, not above it.
		expect(html).toContain('class="changes-flat"')
	})
})
