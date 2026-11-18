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
/** The reply loads the built-in document skill first, as a document request does. */
function withSkill(thread: ThreadState, name = 'document'): ThreadState {
	return send(thread, {
		kind: 'tool_call',
		toolCallId: `skill-${name}`,
		title: 'skill',
		status: 'completed',
		view: { kind: 'generic', label: `Read skill ${name}` },
	} as AcpSessionUpdate)
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
	it('makes a card for a document the document skill wrote, and for nothing else', () => {
		let thread = withSkill(start(emptyThread()))
		thread = wrote(thread, 'a', 'notes/plan.md', '', '# Plan\n')
		thread = wrote(thread, 'b', 'src/app.ts', 'a', 'b')
		thread = wrote(thread, 'c', 'site/index.html', '<p>a</p>', '<p>b</p>')
		thread = wrote(thread, 'd', 'logo.svg', '', '<svg/>')
		const cards = cardsOf(
			thread,
			new Map([['notes/plan.md', { path: 'notes/plan.md', size: 2048, preview: 'Plan' }]]),
		)
		expect(cards.map((card) => card.name)).toEqual(['plan.md'])
		expect(cards[0]).toMatchObject({
			state: 'done',
			stateWord: 'Created',
			kindLine: 'Document · Markdown · 2 KB',
			canCopy: true,
			canOpenInBrowser: false,
			canSave: true,
		})
	})
	it('makes no card for ordinary files, Markdown written with the file tools included', () => {
		let thread = start(emptyThread())
		thread = wrote(thread, 'a', 'notes/plan.md', '', '# Plan\n')
		thread = wrote(thread, 'c', 'site/index.html', '', '<p>b</p>')
		expect(cardsOf(thread)).toEqual([])
		// Another skill's run does not make the Markdown a document.
		expect(
			cardsOf(wrote(withSkill(start(emptyThread()), 'review'), 'a', 'p.md', '', '# x\n')),
		).toEqual([])
	})
	it('calls an edited document Edited', () => {
		let thread = withSkill(start(emptyThread()))
		thread = wrote(thread, 'a', 'plan.md', '# Old\n', '# New\n')
		expect(cardsOf(thread)[0]).toMatchObject({ stateWord: 'Edited' })
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
				facts: { kind: 'write', path: 'site/new.md', operation: 'created' },
				...extra,
			},
		}) as AcpSessionUpdate
	it('shows a writing card while the call runs, named from the call', () => {
		const thread = send(withSkill(start(emptyThread())), call('w', 'pending'))
		expect(cardsOf(thread)).toMatchObject([
			{
				name: 'new.md',
				state: 'writing',
				stateWord: 'Writing',
				kindLine: 'Writing…',
				canOpen: false,
			},
		])
	})
	it('shows a failed card with a plain reason, and a declined one without blame', () => {
		let thread = send(withSkill(start(emptyThread())), call('w', 'pending'))
		thread = send(thread, {
			...call('w', 'failed'),
			facts: { kind: 'failure', reason: 'permission_denied', subject: 'site/new.md' },
		} as AcpSessionUpdate)
		expect(cardsOf(thread)).toMatchObject([
			{
				state: 'failed',
				stateWord: 'Failed',
				kindLine: 'Couldn’t write this file',
				reason: 'Namzu didn’t have permission.',
			},
		])
		let declined = send(withSkill(start(emptyThread())), call('d', 'pending'))
		declined = send(declined, call('d', 'failed', { declined: {} }))
		expect(cardsOf(declined)).toMatchObject([{ state: 'declined', kindLine: 'You declined this' }])
	})
	it('names a write from its diff and its failure, as a real call carries them', () => {
		const diff = (status: 'pending' | 'failed'): AcpSessionUpdate =>
			({
				kind: 'tool_call',
				toolCallId: 'r',
				title: 'write',
				status,
				view: { kind: 'diff', path: 'blocked/report.md', before: '', after: '# Report\n' },
			}) as AcpSessionUpdate
		let thread = send(withSkill(start(emptyThread())), diff('pending'))
		expect(cardsOf(thread)).toMatchObject([{ name: 'report.md', state: 'writing' }])
		thread = send(thread, {
			...diff('failed'),
			facts: { kind: 'failure', reason: 'not_a_file', subject: 'blocked/report.md' },
		} as AcpSessionUpdate)
		expect(cardsOf(thread)).toMatchObject([
			{
				name: 'report.md',
				state: 'failed',
				reason: 'A file is in the way of the folder.',
			},
		])
	})
	it('says a file is gone when the host cannot find it any more', () => {
		let thread = withSkill(start(emptyThread()))
		thread = wrote(thread, 'a', 'plan.md', '', '# x\n')
		const [card] = cardsOf(thread, new Map([['plan.md', { path: 'plan.md', missing: true }]]))
		expect(card).toMatchObject({
			state: 'gone',
			stateWord: 'Missing',
			kindLine: 'No longer in the folder',
			canOpen: false,
		})
	})
	it('adds a document a command made, under the turn that made it, once', () => {
		let thread = withSkill(start(emptyThread()))
		thread = wrote(thread, 'a', 'plan.md', '', '# x\n')
		const made = [
			{ path: '/w/notes.md', turn: thread.turn },
			{ path: '/w/chart.png', turn: thread.turn },
		]
		const cards = turnOutputCards(
			thread,
			thread.turn,
			turnChanges(thread).get(thread.turn),
			outputFiles(thread, made),
			new Map(),
		)
		expect(cards.map((card) => card.name)).toEqual(['plan.md', 'notes.md'])
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
		stateWord: 'Created',
		canOpen: true,
		canOpenInBrowser: false,
		canOpenWithSystem: true,
		canCopy: false,
		canSave: true,
	})
	it('labels the group and names it only when it is longer than the cards shown', () => {
		expect(outputGroupView([card('a.md')], false)).toMatchObject({
			caption: false,
			label: '1 output',
		})
		const many = Array.from({ length: 5 }, (_, index) => card(`f${index}.md`))
		expect(outputGroupView(many, false)).toMatchObject({ caption: true, label: '5 outputs' })
	})
	it('shows three, folds the rest, and expands in place', () => {
		const many = Array.from({ length: 5 }, (_, index) => card(`f${index}.md`))
		const folded = outputGroupView(many, false)
		expect(folded.rows).toHaveLength(CARDS_SHOWN)
		expect(CARDS_SHOWN).toBe(3)
		expect(folded.hidden).toBe(2)
		expect(outputGroupView(many, true)).toMatchObject({ hidden: 0 })
	})
	it('names a card for a screen reader', () => {
		expect(cardAccessibleName({ ...card('a.md'), kindLine: 'Document · Markdown · 1 KB' })).toBe(
			'a.md, Document · Markdown · 1 KB. Open beside the conversation.',
		)
	})
})

describe('folding the cards', () => {
	it('never folds a failed card away: failures come first', () => {
		const done = (name: string) =>
			({ name, path: name, kind: 'document', state: 'done' }) as unknown as OutputCard
		const failed = {
			name: 'report.md',
			path: 'report.md',
			kind: 'document',
			state: 'failed',
		} as unknown as OutputCard
		const cards = [done('a.md'), done('b.md'), done('c.md'), done('d.md'), failed]
		const view = outputGroupView(cards, false)
		expect(view.rows[0]?.name).toBe('report.md')
		expect(view.hidden).toBe(2)
	})
})
