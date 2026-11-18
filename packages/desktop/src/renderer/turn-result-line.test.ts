import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TurnChanges } from './turn-changes.js'
import { TurnResultLine } from './turn-result-line.js'
import { turnResultModel } from './turn-result-model.js'
import type { UndoCardView } from './undo-model.js'

const changes: TurnChanges = {
	turn: 1,
	verb: 'Changed',
	added: 5,
	removed: 0,
	cut: false,
	receiptIds: ['r1'],
	files: [
		{
			name: 'one.txt',
			path: 'notes/one.txt',
			added: 3,
			removed: 0,
			cut: false,
			receiptIds: ['r1'],
			created: true,
		},
	],
}

function render(undo: UndoCardView | undefined, opens: boolean, onUndo = () => {}) {
	const model = turnResultModel({ durationMs: 1000, changes, undo })
	if (!model) throw new Error('no model')
	return renderToStaticMarkup(
		createElement(TurnResultLine, {
			model,
			changes: opens ? changes : undefined,
			onOpen: opens ? () => {} : undefined,
			undo,
			onUndo: undo ? onUndo : undefined,
		}),
	)
}

describe('the actions at the end of the result line', () => {
	it('names View changes, and Undo when the turn can be undone', () => {
		const out = render({ kind: 'enabled' }, true)
		expect(out).toContain('data-turn-action="view-changes"')
		expect(out).toContain('data-turn-action="undo"')
	})
	it('has no Undo when the turn was undone, cannot be, or the host offers none', () => {
		for (const undo of [
			{ kind: 'undone' },
			{ kind: 'disabled', reason: 'Undo expired' },
		] as const) {
			expect(render(undo, true)).not.toContain('data-turn-action="undo"')
		}
		expect(render(undefined, true)).not.toContain('data-turn-action="undo"')
		expect(render(undefined, true)).toContain('data-turn-action="view-changes"')
	})
	it('has no View changes where no receipt carried the edits', () => {
		expect(render({ kind: 'enabled' }, false)).not.toContain('data-turn-action="view-changes"')
	})
})
