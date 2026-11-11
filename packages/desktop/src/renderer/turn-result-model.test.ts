import { describe, expect, it } from 'vitest'
import type { TurnOutcomeSummary } from '../shared/outcome-protocol.js'
import type { TurnChanges } from './turn-changes.js'
import { checkSegment, menuFiles, turnResultModel } from './turn-result-model.js'

const changes = (files: number, added = 32, removed = 1): TurnChanges => ({
	turn: 1,
	verb: 'Changed',
	added,
	removed,
	cut: false,
	receiptIds: [],
	files: Array.from({ length: files }, (_, index) => ({
		name: `f${index}.ts`,
		path: `src/f${index}.ts`,
		added: 1,
		removed: 0,
		cut: false,
		receiptIds: [],
		created: false,
	})),
})
const outcome = (verdict: TurnOutcomeSummary['verdict'], line?: string, changed = 4) =>
	({ verdict, ...(line ? { line } : {}), changed }) as TurnOutcomeSummary

describe('the check segment is only the kernel record sentence', () => {
	it('keeps what follows the lead and never rewrites a command', () => {
		expect(
			checkSegment(
				outcome('checked', 'Changed 4 files · checked: pnpm test passed, nothing changed since'),
			),
		).toEqual({
			text: 'Checked: pnpm test passed, nothing changed since',
			tone: 'ok',
		})
		expect(checkSegment(outcome('failing', 'Changed 4 files · pnpm test failed'))).toEqual({
			text: 'pnpm test failed',
			tone: 'error',
		})
		expect(
			checkSegment(
				outcome('stale', 'Changed 4 files · pnpm test passed, then files changed again'),
			),
		).toEqual({
			text: 'pnpm test passed, then files changed again',
			tone: 'warn',
		})
		expect(
			checkSegment(
				outcome(
					'inconclusive',
					'Changed 4 files · ran npm test | tail, but the pipe hides whether it passed',
				),
			),
		).toEqual({
			text: 'Ran npm test | tail, but the pipe hides whether it passed',
			tone: 'warn',
		})
	})
	it('has no segment for unchecked, unknown, unchanged or a missing sentence', () => {
		expect(checkSegment(outcome('unchecked', 'Changed 4 files · not checked'))).toBeUndefined()
		expect(
			checkSegment(outcome('unknown', 'A command ran that may have changed files · cannot tell')),
		).toBeUndefined()
		expect(checkSegment(outcome('unchanged'))).toBeUndefined()
		expect(checkSegment(outcome('checked'))).toBeUndefined()
		expect(checkSegment(undefined)).toBeUndefined()
	})
})

describe('the result line model', () => {
	it('reads the same facts in its name as on screen', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			durationMs: 3400,
			changes: changes(4),
			outcome: outcome(
				'checked',
				'Changed 4 files · checked: pnpm test passed, nothing changed since',
			),
		})
		expect(model?.label).toBe(
			'Done in 3s, 4 files changed, 32 added, 1 removed, Checked: pnpm test passed, nothing changed since',
		)
		expect(model?.tone).toBe('ok')
		expect(model?.summary.split('\n')[0]).toBe(
			'Done in 3s · 4 files +32 −1 · Checked: pnpm test passed, nothing changed since',
		)
		expect(model?.summary).toContain('src/f3.ts')
	})
	it('shows a failed check in the error tone even on a turn that otherwise ended well', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(2),
			outcome: outcome('failing', 'Changed 2 files · pnpm test failed'),
		})
		expect(model?.tone).toBe('error')
		expect(model?.check?.tone).toBe('error')
	})
	it('says a failing check even when no file changed, and nothing for a quiet turn', () => {
		const failing = turnResultModel({
			reason: 'end_turn',
			outcome: outcome('failing', 'No files changed · pnpm test failed', 0),
		})
		expect(failing?.files).toBe(0)
		expect(failing?.check?.text).toBe('pnpm test failed')
		expect(
			turnResultModel({
				reason: 'end_turn',
				outcome: outcome('unchanged', undefined, 0),
			}),
		).toBeUndefined()
		expect(turnResultModel({ reason: 'end_turn' })).toBeUndefined()
	})
	it('shows counts and no check segment for an unchecked turn', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(4),
			outcome: outcome('unchecked', 'Changed 4 files · not checked'),
		})
		expect(model?.check).toBeUndefined()
		expect(model?.tone).toBe('neutral')
		expect(model?.label).not.toContain('checked')
	})
	it('adds nothing about changes for an unknown record without receipts', () => {
		expect(
			turnResultModel({
				reason: 'end_turn',
				outcome: outcome('unknown', 'A command ran that may have changed files · cannot tell', 3),
			}),
		).toBeUndefined()
	})
	it('says how a turn that did not finish normally ended, and omits a sub-second time', () => {
		expect(
			turnResultModel({
				reason: 'cancelled',
				durationMs: 400,
				changes: changes(1),
			})?.lead,
		).toBe('Stopped')
		expect(
			turnResultModel({
				reason: 'end_turn',
				durationMs: 400,
				changes: changes(1),
			})?.label,
		).toMatch(/^Done, 1 file changed/)
		expect(turnResultModel({ reason: 'end_turn', failed: true, changes: changes(1) })?.tone).toBe(
			'error',
		)
	})
	it('replaces the check with the undo state once the changes were put back', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(2),
			undo: { kind: 'partial', kept: 1 },
		})
		expect(model?.check?.text).toBe('Partly undone, 1 file kept')
	})
	it('keeps a failing check on the row through a partial undo and says the undo beside it', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(2),
			outcome: outcome('failing', 'Changed 2 files · node --test failed'),
			undo: { kind: 'partial', kept: 1 },
		})
		expect(model?.check).toEqual({ text: 'node --test failed', tone: 'error' })
		expect(model?.undo).toBe('Partly undone, 1 file kept')
		expect(model?.tone).toBe('error')
		expect(model?.label).toContain('node --test failed, Partly undone, 1 file kept')
		expect(model?.summary.split('\n')[0]).toContain(
			'node --test failed · Partly undone, 1 file kept',
		)
	})
	it('lets a full undo replace the check, as before', () => {
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(2),
			outcome: outcome('failing', 'Changed 2 files · node --test failed'),
			undo: { kind: 'undone' },
		})
		expect(model?.check?.text).toBe('Undone')
		expect(model?.undo).toBeUndefined()
	})
	it('does not lead with Done when the record says the check failed', () => {
		const failing = outcome('failing', 'Changed 2 files · node --test failed')
		expect(
			turnResultModel({
				reason: 'end_turn',
				durationMs: 1200,
				changes: changes(2),
				outcome: failing,
			})?.label,
		).toMatch(/^Finished in 1s, 2 files changed.*node --test failed$/)
		expect(
			turnResultModel({
				reason: 'cancelled',
				changes: changes(2),
				outcome: failing,
			})?.lead,
		).toBe('Stopped')
		expect(
			turnResultModel({
				reason: 'end_turn',
				failed: true,
				changes: changes(2),
				outcome: failing,
			})?.lead,
		).toBe('Failed')
		expect(
			turnResultModel({
				reason: 'end_turn',
				changes: changes(2),
				outcome: outcome('checked', 'Changed 2 files · checked: x passed'),
			})?.lead,
		).toBe('Done')
	})
	it('shows only the counts for an unknown record and keeps its sentence reachable', () => {
		const line = 'A command ran that may have changed files · cannot tell'
		const model = turnResultModel({
			reason: 'end_turn',
			changes: changes(2),
			outcome: outcome('unknown', line, 3),
		})
		expect(model?.check).toBeUndefined()
		expect(model?.tone).toBe('neutral')
		expect(model?.files).toBe(2)
		const caveat = `These are the edits made with the edit tools. ${line}`
		expect(model?.caveat).toBe(caveat)
		expect(model?.label).toContain(caveat)
		expect(model?.summary.split('\n')[0]).toContain(caveat)
	})
	it('has no caveat when the record is not unknown or no edit was counted', () => {
		expect(
			turnResultModel({
				reason: 'end_turn',
				changes: changes(1),
				outcome: outcome('unchecked', 'Changed 1 file · not checked'),
			})?.caveat,
		).toBeUndefined()
		expect(turnResultModel({ reason: 'end_turn', changes: changes(1) })?.caveat).toBeUndefined()
	})
	it('lists the largest changes first in the menu, and not the files a full undo removed', () => {
		const base = changes(3)
		const sized: TurnChanges = {
			...base,
			files: [
				{ ...base.files[0], path: 'a.ts', added: 1, removed: 0 },
				{
					...base.files[1],
					path: 'b.ts',
					added: 30,
					removed: 2,
					created: true,
				},
				{ ...base.files[2], path: 'c.ts', added: 5, removed: 0 },
			],
		}
		expect(menuFiles(sized).map((file) => file.path)).toEqual(['b.ts', 'c.ts', 'a.ts'])
		expect(menuFiles(sized, { kind: 'partial', kept: 1 }).map((file) => file.path)).toEqual([
			'b.ts',
			'c.ts',
			'a.ts',
		])
		expect(menuFiles(sized, { kind: 'undone' }).map((file) => file.path)).toEqual(['c.ts', 'a.ts'])
		expect(menuFiles(undefined)).toEqual([])
	})
})
