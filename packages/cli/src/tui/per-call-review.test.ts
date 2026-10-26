import { describe, expect, it } from 'vitest'

import type { PermissionMode } from '../permissions/mode.js'
import type { PermissionToolCall } from './agent.js'
import {
	REASON_MAX_CHARS,
	appendTypedReason,
	cleanReason,
	createTerminalPerCallReview,
	noWithReason,
	plainNo,
} from './per-call-review.js'

const edit: PermissionToolCall = { id: 'e', name: 'edit', input: {}, isDestructive: false }
const shell: PermissionToolCall = { id: 's', name: 'bash', input: {}, isDestructive: false }

function review(mode: PermissionMode) {
	return createTerminalPerCallReview({ mode: () => mode })
}

describe("a refusal in the person's own words", () => {
	it('strips control characters and escape sequences from what is recorded', () => {
		expect(cleanReason('  use\u001b[31m the\tother\nfile\u0000  ')).toBe('use [31m the other file')
	})

	it('cuts a long reason by character, not by code unit', () => {
		const long = '😀'.repeat(REASON_MAX_CHARS + 50)
		expect(Array.from(cleanReason(long))).toHaveLength(REASON_MAX_CHARS)
	})

	it('refuses only that call and carries the words to the model', () => {
		expect(noWithReason('  not in prod ')).toEqual({
			kind: 'reject',
			feedback: 'The user declined this and said: not in prod',
			declined: { note: 'not in prod' },
		})
		expect(noWithReason('   \u0007 ')).toBeUndefined()
	})

	it("ends the turn only for a plain No in the person's own conversation", () => {
		expect(plainNo(true)).toEqual({ kind: 'reject', declined: {}, endTurn: true })
		expect(plainNo(false)).toEqual({ kind: 'reject', declined: {} })
	})

	it('caps what is typed and turns line breaks into spaces', () => {
		expect(appendTypedReason('a', 'b\nc\u001bd')).toBe('ab cd')
		const full = appendTypedReason('', 'x'.repeat(REASON_MAX_CHARS + 10))
		expect(Array.from(full)).toHaveLength(REASON_MAX_CHARS)
		expect(appendTypedReason(full, 'more')).toBe(full)
	})
})

describe('what a re-check may approve', () => {
	it('lets bypass cover a plain call but never one that crosses the boundary or always asks', () => {
		const bypass = review('bypass')
		expect(bypass.modeCovers(shell)).toBe(true)
		expect(bypass.modeCovers({ ...shell, escalation: { sandboxEscape: true } })).toBe(false)
		expect(bypass.modeCovers({ ...shell, requiresApproval: true })).toBe(false)
		expect(bypass.modeCovers({ ...shell, authorization: { explicitReview: true } })).toBe(false)
	})

	it('never lets a mode cover a call that a rule or a hook asked about', () => {
		for (const mode of ['bypass', 'accept-edits'] as const) {
			const covering = review(mode)
			expect(covering.modeCovers({ ...edit, authorization: { askRule: true } })).toBe(false)
			expect(covering.modeCovers({ ...edit, hookPermission: { decision: 'ask' } })).toBe(false)
		}
	})

	it('lets accept-edits cover a plain edit and nothing else', () => {
		const accept = review('accept-edits')
		expect(accept.modeCovers(edit)).toBe(true)
		expect(accept.modeCovers(shell)).toBe(false)
		expect(accept.modeCovers({ ...edit, isDestructive: true })).toBe(false)
	})

	it('covers nothing in prompt, plan or strict', () => {
		for (const mode of ['prompt', 'plan', 'strict'] as const) {
			expect(review(mode).modeCovers(edit)).toBe(false)
		}
	})

	it('reads the mode at each check, so a switch mid-queue takes effect', () => {
		let mode: PermissionMode = 'prompt'
		const live = createTerminalPerCallReview({ mode: () => mode })
		expect(live.config.covers?.(edit as never)).toBe(false)
		mode = 'accept-edits'
		expect(live.config.covers?.(edit as never)).toBe(true)
	})

	it('keeps a call open when its input was not shown in full, and one it has not seen', () => {
		const live = review('bypass')
		live.hold('big', true)
		live.hold('small', false)
		expect(live.config.neverCover?.({ ...shell, id: 'big' } as never)).toBe(true)
		expect(live.config.neverCover?.({ ...shell, id: 'small' } as never)).toBe(false)
		expect(live.config.neverCover?.({ ...shell, id: 'unknown' } as never)).toBe(true)
		live.release('small')
		expect(live.config.neverCover?.({ ...shell, id: 'small' } as never)).toBe(true)
	})

	it('tells every listener when the rules or mode change, until it unsubscribes', () => {
		const live = review('prompt')
		let calls = 0
		const off = live.config.onRulesChanged?.(() => {
			calls += 1
		})
		live.rulesChanged()
		live.rulesChanged()
		off?.()
		live.rulesChanged()
		expect(calls).toBe(2)
	})
})
