import { describe, expect, it } from 'vitest'

import {
	type SessionPromptInput,
	approvalStanceSentence,
	composeSessionSystemPrompt,
} from '../system-prompt.js'

const base: SessionPromptInput = {
	resident: false,
	environment: 'ENVIRONMENT',
	delegationAvailable: false,
	workflowOffered: false,
	toolsDeferred: false,
}
const compose = (over: Partial<SessionPromptInput>) =>
	composeSessionSystemPrompt({ ...base, ...over }) ?? ''

describe('the approval stance in the session prompt', () => {
	it.each(['strict', 'classify', 'auto'])(
		'says one sentence under %s, before the environment',
		(mode) => {
			const sentence = approvalStanceSentence(mode)
			expect(sentence).toBeDefined()
			expect(sentence).not.toContain('\n')
			const text = compose({ approvalMode: mode })
			expect(text).toContain(sentence as string)
			expect(text.indexOf(sentence as string)).toBeLessThan(text.indexOf('ENVIRONMENT'))
		},
	)

	it.each(['prompt', 'accept-edits', 'bypass', undefined])('adds nothing under %s', (mode) => {
		expect(approvalStanceSentence(mode)).toBeUndefined()
		expect(compose({ approvalMode: mode })).toBe(compose({ approvalMode: 'prompt' }))
	})

	it('leaves a resident step alone', () => {
		const sentence = approvalStanceSentence('strict') as string
		expect(compose({ resident: true, approvalMode: 'strict' })).not.toContain(sentence)
	})
})

describe('the approval stance and a mid-session mode switch', () => {
	it('does not move with the turn mode', () => {
		const started = composeSessionSystemPrompt({
			...base,
			approvalMode: 'strict',
			permissionMode: 'strict',
		})
		const switched = composeSessionSystemPrompt({
			...base,
			approvalMode: 'strict',
			permissionMode: 'bypass',
		})
		expect(switched).toBe(started)
	})
})
