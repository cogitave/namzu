/**
 * The prompt for a write to a protected path, or a removal that could take the
 * home folder: it says what the call does, and offers no remembered answer,
 * and no switch to accept-edits, because it is asked about every time.
 */

import { describe, expect, it } from 'vitest'

import { permissionChoices, permissionEscalationNotes } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'

const hook: PermissionToolCall = {
	id: 'w1',
	name: 'write',
	input: { path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' },
	isDestructive: false,
	escalation: { protectedPaths: ['/work/proj/.git/hooks/pre-commit'] },
}

const removal: PermissionToolCall = {
	id: 'b1',
	name: 'bash',
	input: { command: 'rm -fr ~' },
	isDestructive: false,
	escalation: { dangerousRemoval: 'rm ~: that is the home directory' },
}

describe('the prompt for a protected write or a catastrophic removal', () => {
	it('names the protected path and says it is asked every time', () => {
		expect(permissionEscalationNotes([hook])).toEqual([
			'Writes a protected file or folder: /work/proj/.git/hooks/pre-commit. Asked every time, in every mode; no earlier answer covers it.',
		])
	})

	it('says a removal could take something that should not be removed by accident', () => {
		const [note] = permissionEscalationNotes([removal])
		expect(note).toMatch(/^Removes something that should not be removed by accident/)
		expect(note).toMatch(/Asked every time/)
	})

	it('offers neither a remembered answer nor accept-edits for either', () => {
		const commands = new Map([['bash', 'command']])
		for (const call of [hook, removal]) {
			expect(
				permissionChoices([call], {
					mode: 'prompt',
					commandArguments: commands,
				}),
			).toEqual(['Yes', 'No, and tell namzu what to do differently (esc)'])
		}
	})
})
