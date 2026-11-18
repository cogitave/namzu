import type { AcpSessionUpdate } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import {
	CARDS_SHOWN,
	type OutputCard,
	cardAccessibleName,
	cardKindLine,
	outputGroupView,
	turnOutputCards,
} from './output-card-model.js'
import { outputFiles } from './outputs-model.js'
import { turnChanges } from './turn-changes.js'

function start(thread: ThreadState): ThreadState {
	return applyEvent(
		applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'go', at: 1000 }),
		{
			kind: 'state',
			sessionId: 's',
			running: true,
			queued: [],
		},
	)
}
const send = (thread: ThreadState, update: AcpSessionUpdate): ThreadState =>
	applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update })
function wrote(thread: ThreadState, id: string, path: string, before: string, after: string) {
	const done: AcpSessionUpdate = {
		kind: 'tool_call',
		toolCallId: id,
		title: 'write',
		status: 'completed',
		view: { kind: 'diff', path, before, after },
		facts: { kind: 'write', path, operation: before ? 'updated' : 'created', added: 2, removed: 0 },
	}
	return send(
		send(thread, { ...done, status: 'pending', facts: undefined } as AcpSessionUpdate),
		done,
	)
}
const cardsOf = (thread: ThreadState, details = new Map()) =>
	turnOutputCards(
		thread,
		thread.turn,
		turnChanges(thread).get(thread.turn),
		outputFiles(thread),
		details,
	)

describe('the kind line', () => {
	it('reads kind, format and size', () => {
		expect(cardKindLine('a/plan.md', 6 * 1024)).toBe('Document · Markdown · 6 KB')
		expect(cardKindLine('chart.png')).toBe('Image · PNG')
		expect(cardKindLine('Makefile', 0)).toBe('File · 0 B')
	})
})

describe('the cards for a reply', () => {
	it('makes a card for a created file, and one for an edited page, but not edited code', () => {
		let thread = start(emptyThread())
		thread = wrote(thread, 'a', 'notes/plan.md', '', '# Plan\n')
		thread = wrote(thread, 'b', 'src/app.ts', 'a', 'b')
		thread = wrote(thread, 'c', 'site/index.html', '<p>a</p>', '<p>b</p>')
		const cards = cardsOf(
			thread,
			new Map([['notes/plan.md', { path: 'notes/plan.md', size: 2048, preview: 'Plan' }]]),
		)
		expect(cards.map((card) => card.name)).toEqual(['plan.md', 'index.html'])
		expect(cards[0]).toMatchObject({
			state: 'done',
			kindLine: 'Document · Markdown · 2 KB',
			preview: 'Plan',
			canCopy: true,
			canOpenInBrowser: false,
			canSave: true,
		})
		expect(cards[1]).toMatchObject({ canOpenInBrowser: true, canOpenWithSystem: true })
	})
	const call = (id: string, status: 'pending' | 'failed', extra: object = {}): AcpSessionUpdate =>
		({
			kind: 'tool_call',
			toolCallId: id,
			title: 'write',
			status,
			view: {
				kind: 'generic',
				label: 'write',
				facts: { kind: 'write', path: 'site/new.html', operation: 'created' },
				...extra,
			},
		}) as AcpSessionUpdate
	it('shows a writing card while the call runs, named from the call', () => {
		const thread = send(start(emptyThread()), call('w', 'pending'))
		expect(cardsOf(thread)).toMatchObject([
			{ name: 'new.html', state: 'writing', kindLine: 'Writing…', canOpen: false },
		])
	})
	it('shows a failed card with a plain reason, and a declined one without blame', () => {
		let thread = send(start(emptyThread()), call('w', 'pending'))
		thread = send(thread, {
			...call('w', 'failed'),
			facts: { kind: 'failure', reason: 'permission_denied', subject: 'site/new.html' },
		} as AcpSessionUpdate)
		expect(cardsOf(thread)).toMatchObject([
			{
				state: 'failed',
				kindLine: 'Couldn’t write this file',
				reason: 'Namzu didn’t have permission.',
			},
		])
		let declined = send(start(emptyThread()), call('d', 'pending'))
		declined = send(declined, call('d', 'failed', { declined: {} }))
		expect(cardsOf(declined)).toMatchObject([{ state: 'declined', kindLine: 'You declined this' }])
	})
	it('says a file is gone when the host cannot find it any more', () => {
		let thread = start(emptyThread())
		thread = wrote(thread, 'a', 'plan.md', '', '# x\n')
		const [card] = cardsOf(thread, new Map([['plan.md', { path: 'plan.md', missing: true }]]))
		expect(card).toMatchObject({
			state: 'gone',
			kindLine: 'No longer in the folder',
			canOpen: false,
		})
	})
	it('adds a file a command made, under the turn that made it, once', () => {
		let thread = start(emptyThread())
		thread = wrote(thread, 'a', 'plan.md', '', '# x\n')
		const made = [{ path: '/w/chart.png', turn: thread.turn }]
		const cards = turnOutputCards(
			thread,
			thread.turn,
			turnChanges(thread).get(thread.turn),
			outputFiles(thread, made),
			new Map(),
		)
		expect(cards.map((card) => card.name)).toEqual(['plan.md', 'chart.png'])
		expect(
			turnOutputCards(thread, thread.turn + 1, undefined, outputFiles(thread, made), new Map()),
		).toEqual([])
	})
})

describe('the group', () => {
	const card = (name: string, kind: OutputCard['kind'] = 'document'): OutputCard => ({
		key: name,
		path: name,
		name,
		kind,
		state: 'done',
		kindLine: 'x',
		canOpen: true,
		canOpenInBrowser: false,
		canOpenWithSystem: true,
		canCopy: false,
		canSave: true,
	})
	it('draws one output large and labels the group', () => {
		expect(outputGroupView([card('a.md')], false)).toMatchObject({ large: true, label: '1 output' })
	})
	it('shows four, folds the rest, and expands in place', () => {
		const many = Array.from({ length: 6 }, (_, index) => card(`f${index}.md`))
		const folded = outputGroupView(many, false)
		expect(folded.rows).toHaveLength(CARDS_SHOWN)
		expect(folded.hidden).toBe(2)
		expect(folded.label).toBe('6 outputs')
		expect(outputGroupView(many, true)).toMatchObject({ hidden: 0 })
	})
	it('pairs two or more pictures and leaves the others in order', () => {
		const view = outputGroupView(
			[card('a.png', 'image'), card('b.md'), card('c.png', 'image')],
			false,
		)
		expect(view.pictures.map((item) => item.name)).toEqual(['a.png', 'c.png'])
		expect(view.rows.map((item) => item.name)).toEqual(['b.md'])
		expect(outputGroupView([card('a.png', 'image'), card('b.md')], false).pictures).toEqual([])
	})
	it('names a card for a screen reader', () => {
		expect(cardAccessibleName({ ...card('a.md'), kindLine: 'Document · Markdown · 1 KB' })).toBe(
			'a.md, Document · Markdown · 1 KB. Open beside the conversation.',
		)
	})
})
