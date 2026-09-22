import { describe, expect, it } from 'vitest'

import { fixtureId } from '../../test-support/ids.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import { mapSessionEventToStreamEvent } from './mapper.js'

/**
 * The nine event kinds added after this mapper's original test was
 * written, none of which it covered.
 *
 * A wire transform with no test is a contract nobody checked: the field
 * names here are what a remote consumer parses, and renaming one is a
 * silent break that type-checking cannot see, because the transform's
 * return type is `Record<string, unknown>`.
 */

const SID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as SessionId
const TID = '0199b3a0-0000-7000-8000-00000000000a' as TurnId

const map = (event: SessionEvent) => mapSessionEventToStreamEvent(event)

describe('the events the original mapper test predates', () => {
	it('carries a reasoning block through its whole lifecycle', () => {
		const started = map({
			type: 'reasoning_started',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			reasoningType: 'thinking',
		} as SessionEvent)
		const delta = map({
			type: 'reasoning_delta',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			text: 'weighing it up',
		} as SessionEvent)
		const completed = map({
			type: 'reasoning_completed',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			signed: true,
		} as SessionEvent)

		expect(started?.wire).toBe('reasoning.started')
		expect(delta?.wire).toBe('reasoning.delta')
		expect(completed?.wire).toBe('reasoning.completed')
		// The index is what groups fragments into one block on the far side.
		expect(delta?.data).toMatchObject({
			session_id: SID,
			turn_id: TID,
			block_index: 0,
			text: 'weighing it up',
		})
	})

	it('says which guardrail fired and what it did', () => {
		const mapped = map({
			type: 'guardrail_triggered',
			sessionId: SID,
			turnId: TID,
			guardrail: 'secret-redaction',
			stage: 'output',
			action: 'rewrite',
			reason: 'a credential was present',
		} as SessionEvent)

		expect(mapped?.wire).toBe('guardrail.triggered')
		// A consumer showing "blocked" versus "rewritten" needs the action,
		// not only that something happened.
		expect(mapped?.data).toMatchObject({
			session_id: SID,
			turn_id: TID,
			guardrail: 'secret-redaction',
			action: 'rewrite',
		})
	})

	it('reports what compaction actually reclaimed', () => {
		const mapped = map({
			type: 'compaction_completed',
			sessionId: SID,
			turnId: TID,
			messagesBefore: 40,
			messagesAfter: 12,
			tokensBefore: 90_000,
			tokensAfter: 30_000,
		} as SessionEvent)

		expect(mapped?.wire).toBe('compaction.completed')
		expect(mapped?.data).toMatchObject({
			messages_before: 40,
			messages_after: 12,
			tokens_before: 90_000,
			tokens_after: 30_000,
		})
	})

	it('names the tool a progress report belongs to', () => {
		// A batch runs several tools at once; progress with no tool id is
		// progress a host cannot render.
		const mapped = map({
			type: 'tool_progress',
			sessionId: SID,
			turnId: TID,
			toolUseId: 'call_1',
			toolName: 'build',
			message: 'compiling',
			fraction: 0.4,
		} as SessionEvent)

		expect(mapped?.wire).toBe('tool.progress')
		expect(mapped?.data).toMatchObject({
			tool_use_id: 'call_1',
			tool_name: 'build',
			message: 'compiling',
			fraction: 0.4,
		})
	})

	it('tells a waiting client that a retry is why nothing is arriving', () => {
		const mapped = map({
			type: 'provider_retry',
			sessionId: SID,
			turnId: TID,
			iteration: 2,
			attempt: 1,
			maxRetries: 3,
			delayMs: 2_000,
			code: 'rate_limit',
			status: 429,
			serverDirected: true,
		} as SessionEvent)

		expect(mapped?.wire).toBe('provider.retry')
		// Without the delay the client has no way to tell a turn that is
		// waiting from a turn that has hung.
		expect(mapped?.data).toMatchObject({
			attempt: 1,
			max_retries: 3,
			delay_ms: 2_000,
			code: 'rate_limit',
			server_directed: true,
		})
	})

	it('carries a question and the answer that resolves it', () => {
		const asked = map({
			type: 'user_question_asked',
			sessionId: SID,
			turnId: TID,
			checkpointId: fixtureId.checkpoint('1'),
			questionId: 'call_1:env',
			question: 'which environment?',
		} as SessionEvent)
		const answered = map({
			type: 'user_question_answered',
			sessionId: SID,
			turnId: TID,
			checkpointId: fixtureId.checkpoint('1'),
			questionId: 'call_1:env',
			answered: true,
		} as SessionEvent)

		expect(asked?.wire).toBe('question.asked')
		expect(answered?.wire).toBe('question.answered')
		// The id is what routes an answer back to the pause that asked, so
		// it has to survive the wire in both directions.
		expect(asked?.data).toMatchObject({ question_id: 'call_1:env' })
		expect(answered?.data).toMatchObject({ question_id: 'call_1:env', answered: true })
	})

	it('always stamps the session and turn the event names', () => {
		const events: SessionEvent[] = [
			{
				type: 'reasoning_delta',
				sessionId: SID,
				turnId: TID,
				iteration: 1,
				messageId: 'm',
				blockIndex: 0,
				text: 'x',
			},
			{
				type: 'guardrail_triggered',
				sessionId: SID,
				turnId: TID,
				guardrail: 'g',
				stage: 'input',
				action: 'block',
			},
			{
				type: 'tool_progress',
				sessionId: SID,
				turnId: TID,
				toolUseId: 'c',
				toolName: 't',
				message: 'm',
			},
		] as SessionEvent[]

		for (const event of events) {
			expect(map(event)?.data).toMatchObject({ session_id: SID, turn_id: TID })
		}
	})
})
