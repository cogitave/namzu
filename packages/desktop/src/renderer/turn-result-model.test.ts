import { describe, expect, it } from 'vitest'
import type { TurnOutcomeSummary } from '../shared/outcome-protocol.js'
import type { TurnChanges } from './turn-changes.js'
import { checkSegment, turnResultModel } from './turn-result-model.js'

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
		).toEqual({ text: 'Checked: pnpm test passed, nothing changed since', tone: 'ok' })
		expect(checkSegment(outcome('failing', 'Changed 4 files · pnpm test failed'))).toEqual({
			text: 'pnpm test failed',
			tone: 'error',
		})
		expect(
			checkSegment(
				outcome('stale', 'Changed 4 files · pnpm test passed, then files changed again'),
			),
		).toEqual({ text: 'pnpm test passed, then files changed again', tone: 'warn' })
		expect(
			checkSegment(
				outcome(
					'inconclusive',
					'Changed 4 files · ran npm test | tail, but the pipe hides whether it passed',
				),
			),
		).toEqual({ text: 'Ran npm test | tail, but the pipe hides whether it passed', tone: 'warn' })
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
			turnResultModel({ reason: 'end_turn', outcome: outcome('unchanged', undefined, 0) }),
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
			turnResultModel({ reason: 'cancelled', durationMs: 400, changes: changes(1) })?.lead,
		).toBe('Stopped')
		expect(
			turnResultModel({ reason: 'end_turn', durationMs: 400, changes: changes(1) })?.label,
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
})
