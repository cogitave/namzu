import { describe, expect, it } from 'vitest'

import { fixtureId } from '../../test-support/ids.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'
import { mapRunToStreamEvent } from './mapper.js'

/**
 * The nine event kinds added after this mapper's original test was
 * written, none of which it covered.
 *
 * A wire transform with no test is a contract nobody checked: the field
 * names here are what a remote consumer parses, and renaming one is a
 * silent break that type-checking cannot see, because the transform's
 * return type is `Record<string, unknown>`.
 */

const RID = 'run_1' as RunId

const map = (event: RunEvent) => mapRunToStreamEvent(event, RID)

describe('the events the original mapper test predates', () => {
	it('carries a reasoning block through its whole lifecycle', () => {
		const started = map({
			type: 'reasoning_started',
			runId: RID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			reasoningType: 'thinking',
		} as RunEvent)
		const delta = map({
			type: 'reasoning_delta',
			runId: RID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			text: 'weighing it up',
		} as RunEvent)
		const completed = map({
			type: 'reasoning_completed',
			runId: RID,
			iteration: 1,
			messageId: fixtureId.message('1'),
			blockIndex: 0,
			signed: true,
		} as RunEvent)

		expect(started?.wire).toBe('reasoning.started')
		expect(delta?.wire).toBe('reasoning.delta')
		expect(completed?.wire).toBe('reasoning.completed')
		// The index is what groups fragments into one block on the far side.
		expect(delta?.data).toMatchObject({ run_id: RID, block_index: 0, text: 'weighing it up' })
	})

	it('says which guardrail fired and what it did', () => {
		const mapped = map({
			type: 'guardrail_triggered',
			runId: RID,
			guardrail: 'secret-redaction',
			stage: 'output',
			action: 'rewrite',
			reason: 'a credential was present',
		} as RunEvent)

		expect(mapped?.wire).toBe('guardrail.triggered')
		// A consumer showing "blocked" versus "rewritten" needs the action,
		// not only that something happened.
		expect(mapped?.data).toMatchObject({
			run_id: RID,
			guardrail: 'secret-redaction',
			action: 'rewrite',
		})
	})

	it('reports what compaction actually reclaimed', () => {
		const mapped = map({
			type: 'compaction_completed',
			runId: RID,
			messagesBefore: 40,
			messagesAfter: 12,
			tokensBefore: 90_000,
			tokensAfter: 30_000,
		} as RunEvent)

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
			runId: RID,
			toolUseId: 'call_1',
			toolName: 'build',
			message: 'compiling',
			fraction: 0.4,
		} as RunEvent)

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
			runId: RID,
			iteration: 2,
			attempt: 1,
			maxRetries: 3,
			delayMs: 2_000,
			code: 'rate_limit',
			status: 429,
			serverDirected: true,
		} as RunEvent)

		expect(mapped?.wire).toBe('provider.retry')
		// Without the delay the client has no way to tell a run that is
		// waiting from a run that has hung.
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
			runId: RID,
			checkpointId: fixtureId.checkpoint('1'),
			questionId: 'call_1:env',
			question: 'which environment?',
		} as RunEvent)
		const answered = map({
			type: 'user_question_answered',
			runId: RID,
			checkpointId: fixtureId.checkpoint('1'),
			questionId: 'call_1:env',
			answered: true,
		} as RunEvent)

		expect(asked?.wire).toBe('question.asked')
		expect(answered?.wire).toBe('question.answered')
		// The id is what routes an answer back to the pause that asked, so
		// it has to survive the wire in both directions.
		expect(asked?.data).toMatchObject({ question_id: 'call_1:env' })
		expect(answered?.data).toMatchObject({ question_id: 'call_1:env', answered: true })
	})

	it('always stamps the run id it was given', () => {
		const events: RunEvent[] = [
			{
				type: 'reasoning_delta',
				runId: RID,
				iteration: 1,
				messageId: 'm',
				blockIndex: 0,
				text: 'x',
			},
			{ type: 'guardrail_triggered', runId: RID, guardrail: 'g', stage: 'input', action: 'block' },
			{ type: 'tool_progress', runId: RID, toolUseId: 'c', toolName: 't', message: 'm' },
		] as RunEvent[]

		for (const event of events) {
			expect(map(event)?.data.run_id).toBe(RID)
		}
	})
})
