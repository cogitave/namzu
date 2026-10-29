import { describe, expect, it } from 'vitest'

import { delegatedAgentMode } from '../delegated-mode.js'
import type { PermissionMode } from '../mode.js'

describe('the mode an agent file can ask for', () => {
	it('narrows a parent that asks before changes', () => {
		expect(delegatedAgentMode({ parent: 'prompt', declared: 'plan' })).toBe('plan')
		expect(delegatedAgentMode({ parent: 'prompt', declared: 'accept-edits' })).toBe('accept-edits')
	})

	it('leaves the parent’s mode when the file names none or says inherit', () => {
		expect(delegatedAgentMode({ parent: 'prompt', declared: undefined })).toBe('prompt')
		expect(delegatedAgentMode({ parent: 'prompt', declared: 'inherit' })).toBe('prompt')
		expect(delegatedAgentMode({ parent: 'prompt', declared: 'prompt' })).toBe('prompt')
	})

	it.each(['bypass', 'auto', 'strict'])('never grants %s from a file', (declared) => {
		expect(delegatedAgentMode({ parent: 'prompt', declared })).toBe('prompt')
	})

	it.each<PermissionMode>(['accept-edits', 'plan', 'bypass', 'classify', 'strict', 'auto'])(
		'lets a parent in %s keep its own mode over the file',
		(parent) => {
			expect(delegatedAgentMode({ parent, declared: 'plan' })).toBe(parent)
			expect(delegatedAgentMode({ parent, declared: 'accept-edits' })).toBe(parent)
		},
	)
})
