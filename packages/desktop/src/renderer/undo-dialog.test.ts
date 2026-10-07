import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { restoreHistoryWork } from '../shared/history-work.js'
import { applyEvent, emptyThread } from '../shared/projection.js'
import type { DesktopTurnUndo, DesktopUndoFile, DesktopUndoPreview } from '../shared/protocol.js'
import { TurnChangesCard } from './turn-changes-card.js'
import { turnChanges, turnUndo } from './turn-changes.js'
import { UndoPlanBody, UndoResultBody } from './undo-dialog.js'
import {
	SHELL_WARNING,
	normalizeChoices,
	partialLabel,
	primaryLabel,
	queuedWarning,
	resolutionsFor,
	summarize,
	undoCardView,
} from './undo-model.js'

const file = (
	rel: string,
	action: DesktopUndoFile['action'],
	reason?: DesktopUndoFile['reason'],
	turnId = 't2',
): DesktopUndoFile => ({ turnId, path: `/w/${rel}`, rel, action, ...(reason ? { reason } : {}) })
const plan = (overrides: Partial<DesktopUndoPreview> = {}): DesktopUndoPreview => ({
	turnId: 't2',
	status: 'applied',
	planToken: 'tok',
	files: [
		file('a.ts', 'restore'),
		file('new.md', 'delete'),
		file('b.ts', 'conflict', 'drifted'),
		file('c.ts', 'conflict', 'later-reply'),
		file('d.ts', 'noop'),
	],
	skipped: [{ path: '/w/big.bin', reason: 'too-large' }],
	uncoveredShell: true,
	laterTurnsOnSameFiles: ['t3'],
	...overrides,
})
const row = (status: DesktopTurnUndo['status'], extra: Partial<DesktopTurnUndo> = {}) => ({
	turnId: 't2',
	status,
	files: 2,
	added: 0,
	removed: 0,
	uncoveredShell: false,
	skipped: [],
	...extra,
})
const body = (preview: DesktopUndoPreview, choices = {}, props = {}) =>
	renderToStaticMarkup(
		createElement(UndoPlanBody, {
			preview,
			choices,
			onChoice: () => undefined,
			alsoLater: false,
			onAlsoLater: () => undefined,
			queued: 0,
			...props,
		}),
	)

describe('undo card state', () => {
	it('is hidden without a status, with nothing covered, and while the turn has no id', () => {
		expect(undoCardView(undefined, { busy: false })).toBeUndefined()
		expect(undoCardView(row('none'), { busy: false })).toBeUndefined()
	})
	it('maps every status to one state', () => {
		expect(undoCardView(row('applied'), { busy: false })).toEqual({ kind: 'enabled' })
		expect(undoCardView(row('applied'), { busy: true })).toEqual({
			kind: 'disabled',
			reason: 'Wait for the current reply',
		})
		expect(undoCardView(row('expired'), { busy: false })).toEqual({
			kind: 'disabled',
			reason: 'Undo expired',
		})
		expect(undoCardView(row('undone', { undoneAt: 5 }), { busy: true })).toEqual({
			kind: 'undone',
			at: 5,
		})
		expect(undoCardView(row('partially_undone'), { busy: false, kept: 2 })).toEqual({
			kind: 'partial',
			kept: 2,
		})
	})
	it('words the partial state with its count', () => {
		expect(partialLabel(2)).toBe('Partly undone, 2 files kept')
		expect(partialLabel(1)).toBe('Partly undone, 1 file kept')
		expect(partialLabel()).toBe('Partly undone')
	})
})

describe('undo card join', () => {
	const rows = [
		{ role: 'user' as const, text: 'one' },
		{ role: 'assistant' as const, text: 'done' },
	]
	const work = {
		v: 1 as const,
		partial: false,
		messages: [
			{ index: 0, messageId: 'u1', turnId: 'turn-9', order: 1 },
			{ index: 1, messageId: 'a1', turnId: 'turn-9', order: 3 },
		],
		turns: [
			{
				turnId: 'turn-9',
				userMessageId: 'u1',
				order: 0,
				status: 'completed' as const,
				reason: 'end_turn',
			},
		],
		tools: [
			{
				turnId: 'turn-9',
				toolUseId: 'e1',
				name: 'write',
				order: 2,
				status: 'completed' as const,
				presentation: { kind: 'diff' as const, path: 'a.ts', before: 'x\n', after: 'y\n' },
			},
		],
	}
	it('reads the state of the journal turn the card belongs to, rebuilt from history', () => {
		const cold = restoreHistoryWork(emptyThread(), rows, work)
		const thread = applyEvent(cold, {
			kind: 'undo-status',
			sessionId: 's',
			turns: [row('undone', { turnId: 'turn-9' })],
		})
		const joined = turnUndo(thread, 1, () => undefined)
		expect(joined.undo).toEqual({ kind: 'undone' })
		expect(turnUndo(thread, 1, undefined)).toEqual({})
		expect(turnUndo({ ...thread, turns: {} }, 1, () => undefined)).toEqual({})
	})
	it('shows nothing on a reply that has not been given an id yet', () => {
		const thread = { ...emptyThread(), turns: { 1: {} }, undo: { x: row('applied') } }
		expect(turnUndo(thread, 1, () => undefined)).toEqual({})
	})
	it('draws the Undo button, the undone chip and the partial button from that state', () => {
		const cold = restoreHistoryWork(emptyThread(), rows, work)
		const changes = turnChanges(cold).get(1)
		if (!changes) throw new Error('no changes')
		const render = (undo: ReturnType<typeof undoCardView>) =>
			renderToStaticMarkup(
				createElement(TurnChangesCard, {
					changes,
					onOpen: () => undefined,
					undo,
					onUndo: () => undefined,
				}),
			)
		expect(render({ kind: 'enabled' })).toContain('data-undo-state="enabled"')
		expect(render({ kind: 'disabled', reason: 'Undo expired' })).toContain('aria-disabled="true"')
		expect(render({ kind: 'undone', at: Date.UTC(2026, 9, 7, 10, 42) })).toMatch(/Undone at /)
		expect(render({ kind: 'undone' })).toContain('data-undo="undone"')
		expect(render({ kind: 'partial', kept: 2 })).toContain('Partly undone, 2 files kept')
		expect(render(undefined)).not.toContain('Undo')
	})
})

describe('undo plan choices', () => {
	it('counts what will change and skips conflicts by default', () => {
		expect(summarize(plan(), {})).toEqual({ changing: 2, skipping: 2, nothing: 1 })
		expect(primaryLabel(2)).toBe('Undo 2 files')
		expect(primaryLabel(1)).toBe('Undo 1 file')
		expect(primaryLabel(0)).toBe('Nothing to undo')
	})
	it('lets only a drifted file be restored anyway, and sends only that choice', () => {
		const choices = { '/w/b.ts': 'keep_copy', '/w/c.ts': 'keep_copy' } as const
		expect(summarize(plan(), choices).changing).toBe(3)
		expect(resolutionsFor(plan(), choices)).toEqual({ '/w/b.ts': 'keep_copy' })
		expect(normalizeChoices(plan({ files: [file('a.ts', 'restore')] }), choices)).toEqual({})
	})
	it('words the queued-message warning', () => {
		expect(queuedWarning(0)).toBeUndefined()
		expect(queuedWarning(1)).toContain('1 queued message was written')
		expect(queuedWarning(3)).toContain('3 queued messages were written')
	})
})

describe('undo dialog body', () => {
	it('lists restore, delete and conflict rows with the reasons and the choice', () => {
		const html = body(plan())
		expect(html).toContain('data-action="restore"')
		expect(html).toContain('data-action="delete"')
		expect(html).toContain('Changed since this reply')
		expect(html).toContain('A later reply changed it too')
		expect(html).toContain('Restore anyway, keep my copy')
		expect(html).toMatch(/name="undo-choice:t2:\/w\/b\.ts"[^>]*checked/)
		// The later-reply conflict has no way to force it.
		expect(html.match(/Restore anyway/g)).toHaveLength(1)
	})
	it('states the shell warning, the not-covered list and the later-replies box', () => {
		const html = body(plan())
		expect(html).toContain(SHELL_WARNING)
		expect(html).toContain('Not covered')
		expect(html).toContain('Larger than 8 MiB')
		expect(html).toContain('Also undo later replies')
		expect(
			body(plan({ uncoveredShell: false, laterTurnsOnSameFiles: [], skipped: [] })),
		).not.toContain('Not covered')
	})
	it('separates later replies once they are included, and warns about queued messages', () => {
		const html = body(
			plan({ files: [file('c.ts', 'restore', undefined, 't3'), file('a.ts', 'restore')] }),
			{},
			{ alsoLater: true, queued: 2 },
		)
		expect(html).toContain('From later replies')
		expect(html).toContain('2 queued messages were written')
		expect(html).toMatch(/type="checkbox"[^>]*checked/)
	})
	it('shows a refreshed plan with the reason it was refreshed', () => {
		expect(body(plan(), {}, { notice: 'The files changed since this preview.' })).toContain(
			'<output class="undo-notice">The files changed since this preview.</output>',
		)
	})
	it('reports a partial result file by file with the copies it kept', () => {
		const html = renderToStaticMarkup(
			createElement(UndoResultBody, {
				names: { '/w/a.ts': 'a.ts', '/w/b.ts': 'b.ts' },
				result: {
					turnId: 't2',
					status: 'partially_undone',
					files: { '/w/a.ts': 'restored', '/w/b.ts': 'skipped' },
					copies: [{ path: '/w/b.ts', sha256: 'f'.repeat(64) }],
				},
			}),
		)
		expect(html).toContain('Partly undone.')
		expect(html).toContain('Restored')
		expect(html).toContain('Skipped')
		expect(html).toContain('Copies kept')
	})
})
