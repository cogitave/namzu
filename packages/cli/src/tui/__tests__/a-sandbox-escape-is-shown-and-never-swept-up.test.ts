/**
 * The prompt a person answers for a boundary crossing: it says what the call
 * crosses, and an "allow all" answered on one prompt never settles a queued
 * sandbox escape, or a queued path outside the working directory, that was
 * not on screen.
 */

import { describe, expect, it } from 'vitest'

import { permissionChoices, permissionEscalationNotes } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'
import {
	buildPermissionReview,
	buildPermissionSummary,
	releasedByApproveAll,
} from '../permission-review.js'

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
			'Runs OUTSIDE the sandbox, on this machine. Asked every time; "allow all" never covers it.',
		])
		expect(permissionEscalationNotes([outsideRead])).toEqual([
			'Outside the working directory: /mnt/c/Users/me/notes.txt. Asked every time; "allow all" never covers it.',
		])
		expect(permissionEscalationNotes([ordinary])).toEqual([])
	})

	it('does not offer "allow all tools" as if it covered the escape', () => {
		expect(permissionChoices([escapeCall])[1]).toBe(
			'Yes, and allow other tools for this session (not sandbox escapes)',
		)
		expect(permissionChoices([outsideRead])[1]).toBe(
			'Yes, and allow other tools for this session (not paths outside it)',
		)
		expect(permissionChoices([ordinary])[1]).toBe('Yes, allow all tools for this session')
	})

	it('shows the escape in the readable view instead of dropping to the exact one', () => {
		const review = buildPermissionReview([escapeCall])
		expect(review.ok).toBe(true)
		const summary = buildPermissionSummary(review.ok ? review.text : '')
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('sandbox: OFF for this command (runs on the host)')
	})
})

describe('an "allow all" answered on another prompt', () => {
	it('settles queued ordinary calls but never a queued escape or outside path', () => {
		expect(releasedByApproveAll([ordinary])).toBe(true)
		expect(releasedByApproveAll([outsideRead])).toBe(false)
		expect(releasedByApproveAll([ordinary, outsideRead])).toBe(false)
		expect(releasedByApproveAll([ordinary, escapeCall])).toBe(false)
	})
})
