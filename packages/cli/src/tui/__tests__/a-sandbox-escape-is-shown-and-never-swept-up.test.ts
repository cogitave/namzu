/**
 * The prompt a person answers for a boundary crossing: it says what the call
 * crosses, and offers no remembered answer for it: a sandbox escape, or a path
 * outside the working directory, is asked about every time.
 */

import { describe, expect, it } from 'vitest'

import { permissionChoices, permissionEscalationNotes } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'

const escapeCall: PermissionToolCall = {
	id: 'b1',
	name: 'bash',
	input: { command: 'curl -sI https://example.com', dangerously_disable_sandbox: true },
	isDestructive: false,
	escalation: { sandboxEscape: true },
}

const outsideRead: PermissionToolCall = {
	id: 'r1',
	name: 'read',
	input: { path: '/mnt/c/Users/me/notes.txt' },
	isDestructive: false,
	escalation: { outsidePaths: ['/mnt/c/Users/me/notes.txt'] },
}

const ordinary: PermissionToolCall = {
	id: 'w1',
	name: 'write',
	input: { path: 'a.txt', content: 'x' },
	isDestructive: false,
}

describe('the prompt for a boundary crossing', () => {
	it('says a command runs outside the sandbox, and a path is outside the working directory', () => {
		expect(permissionEscalationNotes([escapeCall])).toEqual([
			'Runs OUTSIDE the sandbox, on this machine. Asked every time; no earlier answer covers it.',
		])
		expect(permissionEscalationNotes([outsideRead])).toEqual([
			'Outside the working directory: /mnt/c/Users/me/notes.txt. Asked every time; no earlier answer covers it.',
		])
		expect(permissionEscalationNotes([ordinary])).toEqual([])
	})

	it('offers no remembered answer for an escape or an outside path', () => {
		const commands = new Map([['bash', 'command']])
		for (const call of [escapeCall, outsideRead]) {
			expect(permissionChoices([call], { mode: 'prompt', commandArguments: commands })).toEqual([
				'Yes',
				'No, and tell namzu what to do differently (esc)',
			])
		}
		// Not even beside a call that would otherwise carry one.
		expect(
			permissionChoices([ordinary, escapeCall], { mode: 'prompt', commandArguments: commands }),
		).toHaveLength(2)
	})

	it('shows the escape in the readable view instead of dropping to the exact one', () => {
		const review = buildPermissionReview([escapeCall])
		expect(review.ok).toBe(true)
		const summary = buildPermissionSummary(review.ok ? review.text : '')
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('sandbox: OFF for this command (runs on the host)')
	})
})
