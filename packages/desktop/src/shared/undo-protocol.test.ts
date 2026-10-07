import { describe, expect, it } from 'vitest'
import { applyEvent } from './projection.js'
import { emptyThread } from './projection.js'
import { readUndoPreview, readUndoResult, readUndoStatus } from './undo-protocol.js'

const status = {
	turnId: 'turn-1',
	status: 'applied',
	files: 2,
	added: 1,
	removed: 0,
	uncoveredShell: true,
	skipped: [{ path: '/w/big.bin', reason: 'too-large' }],
}
const preview = {
	turnId: 'turn-1',
	status: 'applied',
	planToken: 'tok',
	files: [
		{ turnId: 'turn-1', path: '/w/a.ts', rel: 'a.ts', action: 'restore' },
		{ turnId: 'turn-1', path: '/w/b.ts', rel: 'b.ts', action: 'conflict', reason: 'drifted' },
		{
			turnId: 'turn-1',
			path: '/w/c.ts',
			rel: 'c.ts',
			action: 'conflict',
			reason: 'later-reply',
			blockedBy: ['turn-2'],
		},
	],
	skipped: [],
	uncoveredShell: false,
	laterTurnsOnSameFiles: ['turn-2'],
}

describe('undo wire guards', () => {
	it('accepts what the CLI sends', () => {
		expect(readUndoStatus({ turns: [status] })).toEqual([status])
		expect(readUndoPreview(preview)?.files).toHaveLength(3)
		expect(
			readUndoResult({ turnId: 'turn-1', status: 'undone', files: { '/w/a.ts': 'restored' } }),
		).toMatchObject({ status: 'undone' })
	})
	it('refuses a status or plan that is out of range or the wrong shape', () => {
		expect(readUndoStatus({ turns: [{ ...status, status: 'weird' }] })).toBeUndefined()
		expect(readUndoStatus({ turns: [{ ...status, files: -1 }] })).toBeUndefined()
		expect(readUndoStatus({ turns: 'none' })).toBeUndefined()
		expect(readUndoPreview({ ...preview, planToken: '' })).toBeUndefined()
		expect(
			readUndoPreview({ ...preview, files: [{ ...preview.files[0], action: 'overwrite' }] }),
		).toBeUndefined()
	})
	it('requires a plan-changed result to carry the plan it wants shown', () => {
		expect(readUndoResult({ turnId: 'turn-1', status: 'plan-changed', files: {} })).toBeUndefined()
		expect(
			readUndoResult({ turnId: 'turn-1', status: 'plan-changed', files: {}, replan: preview })
				?.replan?.planToken,
		).toBe('tok')
	})
	it('keeps a path named __proto__ as a path', () => {
		const result = readUndoResult({
			turnId: 'turn-1',
			status: 'undone',
			files: JSON.parse('{"__proto__": "skipped"}'),
		})
		expect(Object.keys(result?.files ?? {})).toEqual(['__proto__'])
	})
})

describe('undo state in the projection', () => {
	it('merges per turn, keeps the observed time while the status stands and drops it otherwise', () => {
		const rows = readUndoStatus({ turns: [status] }) ?? []
		let thread = applyEvent(emptyThread(), { kind: 'undo-status', sessionId: 's', turns: rows })
		expect(thread.undo?.['turn-1']?.status).toBe('applied')
		thread = applyEvent(thread, {
			kind: 'undo-status',
			sessionId: 's',
			turns: [{ ...rows[0], status: 'undone', undoneAt: 1_000 }],
		})
		thread = applyEvent(thread, {
			kind: 'undo-status',
			sessionId: 's',
			turns: [{ ...rows[0], status: 'undone' }],
		})
		expect(thread.undo?.['turn-1']).toMatchObject({ status: 'undone', undoneAt: 1_000 })
		thread = applyEvent(thread, {
			kind: 'undo-status',
			sessionId: 's',
			turns: [{ ...rows[0], status: 'partially_undone' }],
		})
		expect(thread.undo?.['turn-1']?.undoneAt).toBeUndefined()
	})
})
