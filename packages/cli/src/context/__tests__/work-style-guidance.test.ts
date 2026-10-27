import { describe, expect, it } from 'vitest'

import { CONVERSATION_EVIDENCE_GUIDANCE } from '../../integrations/sessions/conversation-search.js'
import { composeMemoryGuidance } from '../../memory/typed.js'
import { NAMZU_DELEGATION_DOCTRINE, NAMZU_WORKING_DOCTRINE } from '../doctrine.js'

/**
 * How the model is told to work with the person: keep them informed through a
 * long turn, report what delegated agents found, look back before repeating an
 * investigation, and read the recorded fields it is shown.
 */

describe('keeping the person informed', () => {
	it('asks for a line before the first tool call and short updates at key moments', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain('Before your first tool call, say in one short line')
		expect(NAMZU_WORKING_DOCTRINE).toContain('find something, change direction or hit a blocker')
		expect(NAMZU_WORKING_DOCTRINE).toContain('after a long stretch without one')
	})

	it('opens a task list for work of three or more steps', () => {
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('work of three or more steps')
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('two-step job')
	})
})

describe('reporting delegated work', () => {
	it('tells the model to pass finished results on in its next message', () => {
		expect(NAMZU_DELEGATION_DOCTRINE).toContain(
			'When delegated agents finish, tell the user what each one found in your next message.',
		)
	})
})

describe('looking back before investigating again', () => {
	it('sends the model to the conversation first when an error comes back', () => {
		expect(CONVERSATION_EVIDENCE_GUIDANCE).toContain(
			'Before you investigate an error again, search this conversation for a short phrase from it',
		)
	})
})

describe('recorded fields are explained in plain words', () => {
	it('names every field a recalled-evidence quote carries', () => {
		for (const key of [
			'visibleEvidence',
			'textQuote',
			'recordKind',
			'toolName',
			'isError',
			'omittedVisibleEvidence',
			'excerptGuidance',
			'recordKindGuidance',
			'visibleEvidenceGuidance',
		]) {
			expect(CONVERSATION_EVIDENCE_GUIDANCE, key).toContain(`\`${key}\``)
		}
	})

	it('names the fields of a recalled memory line', () => {
		const guidance = composeMemoryGuidance({ taskList: true })
		expect(guidance).toContain('`updatedAt`')
		expect(guidance).toContain('`sourceTurn`')
	})
})
