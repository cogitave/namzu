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
	it('asks for one line before the first call of long work and one when something is found', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain(
			'For work that takes several calls, say one short line before the first call',
		)
		expect(NAMZU_WORKING_DOCTRINE).toContain(
			'when you find something, change direction or hit a blocker',
		)
		expect(NAMZU_WORKING_DOCTRINE).toContain('none for a question that needs one look')
	})

	it('makes a task list optional, for work of three or more distinct steps', () => {
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('A task list is optional')
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('three or more distinct steps')
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('two-step job')
	})
})

describe('reporting delegated work', () => {
	it('tells the model to pass finished results on in its next message', () => {
		expect(NAMZU_DELEGATION_DOCTRINE).toContain('tell the user what each delegated agent found')
	})
})

describe('looking back before investigating again', () => {
	it('has the model look at what it can see before it searches, when an error comes back', () => {
		expect(CONVERSATION_EVIDENCE_GUIDANCE).toContain(
			'Before you investigate an error again, look at the earlier turns you can see; only when its output is no longer visible, search this conversation for a short phrase from it',
		)
	})

	it('opens with the one rule about history, and says what to do after an empty search', () => {
		expect(CONVERSATION_EVIDENCE_GUIDANCE).toContain(
			'## Conversation evidence\nIf the answer is in your own earlier messages or tool results that are visible now, answer from them; do not search. Use the history tools only for something no longer visible (after compaction or a restart).',
		)
		expect(CONVERSATION_EVIDENCE_GUIDANCE).toContain(
			'After one empty or incomplete history search, answer from what is in context and say what is unverified',
		)
		expect(CONVERSATION_EVIDENCE_GUIDANCE).not.toContain(
			'This works before compaction as well as after',
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
