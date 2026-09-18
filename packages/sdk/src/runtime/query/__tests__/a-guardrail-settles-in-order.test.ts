import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { OutputGuardrailSpec } from '../../../types/guardrail/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { AgentPersona } from '../../../types/persona/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { secretRedactionGuardrail } from '../guardrail-presets.js'
import { drainQuery } from '../index.js'

/**
 * WHERE the output guardrail announces itself, in a real run's stream.
 *
 * `guardrails-e2e.test.ts` drives the same path and asserts what a guardrail
 * DOES — the block settles the run as `output_guardrail`, the rewrite reaches
 * `Run.result` — but it asks `events.find(...)`, which is satisfied wherever
 * the event sits. Nothing pinned WHERE it sits.
 *
 * That gap matters more than it looks, because the block is now the body of
 * `finalize-run.ts`: it emits `guardrail_triggered`, drains, and only then
 * hands the run to the assembler. An emit moved past `completeRun` would
 * still be found by a `find` and would arrive after the run had settled, and
 * a host folding the stream in order is exactly the reader that would be
 * wronged by it: it records the run, then receives a correction to a result
 * it has already settled.
 *
 * An emit moved past its OWN `drainPending` is a different thing and is NOT
 * what this file pins: the translator's queue is flushed in push order, so
 * such an event keeps its place and merely arrives in a later batch. The
 * batch boundaries are not part of the stream contract; the position of
 * `guardrail_triggered` relative to `run_completed` is, and that is what is
 * asserted below (and what a mutation can break).
 *
 * The runs below are real `query()` calls: the guardrail fires inside the
 * settlement, between the loop's last event and the run's terminal one.
 */

const workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

async function runWithOutputGuardrail(opts: {
	responseText: string
	guardrails: readonly OutputGuardrailSpec[]
	persona?: AgentPersona
}): Promise<{ result: Awaited<ReturnType<typeof drainQuery>>; events: RunEvent[] }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-guardrail-order-'))
	workdirs.push(workingDirectory)

	const events: RunEvent[] = []
	const result = await drainQuery(
		{
			provider: new MockLLMProvider({ turns: [{ text: opts.responseText }] }),
			tools: new ToolRegistry(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_guardrail_order',
			agentName: 'Guardrail order agent',
			messages: [createUserMessage('what is the deploy key?')],
			workingDirectory,
			sessionId: '423aea7e-9557-49e3-8c9e-665e12b79391' as SessionId,
			topicId: '26de5705-2f61-4c2a-8f64-39ff8f8587bb' as TopicId,
			projectId: 'a9382cd4-7476-42e1-bd76-7353d47a3907' as ProjectId,
			tenantId: '108babb0-2135-4a4a-87c4-a7f9a81dfaf7' as TenantId,
			outputGuardrails: [...opts.guardrails],
			...(opts.persona ? { persona: opts.persona } : {}),
		},
		(event) => {
			events.push(event)
		},
	)

	return { result, events }
}

/** A persona, so the block's `persona?.identity.role` arm is taken too. */
const PERSONA: AgentPersona = { identity: { role: 'operator', description: 'the operator' } }

const types = (events: readonly RunEvent[]): string[] => events.map((event) => event.type)

describe('an output guardrail that fires', () => {
	it('announces itself after the iteration that produced the text, and before the run settles', async () => {
		const { result, events } = await runWithOutputGuardrail({
			responseText: 'AKIAIOSFODNN7EXAMPLE',
			guardrails: [secretRedactionGuardrail({ onMatch: 'block' })],
			// The block branch records an audit entry whose `persona` field is
			// read through `params.persona?.identity.role`; with no persona on
			// the run only the short-circuit edge of that read is ever taken.
			persona: PERSONA,
		})

		// The whole ordered stream, pinned. Every event between the block's own
		// `guardrail_triggered` and the terminal `run_completed` is a position
		// the settlement fixes: the block sits after the loop's last
		// `iteration_completed` (the text it judges already reached the host,
		// as `text_delta`, while the model produced it) and before
		// `completeRun`, which is why a host folding the stream in order never
		// sees the run settle before it hears the correction.
		expect(types(events)).toEqual([
			'run_started',
			'activity_created',
			'activity_updated',
			'iteration_started',
			'request_envelope',
			'message_started',
			'text_delta',
			'text_delta',
			'text_delta',
			'message_completed',
			'token_usage_updated',
			'activity_updated',
			'iteration_completed',
			'guardrail_triggered',
			'run_completed',
		])

		const triggered = events.findIndex((event) => event.type === 'guardrail_triggered')
		const completed = events.findIndex((event) => event.type === 'run_completed')
		expect(triggered).toBeGreaterThan(-1)
		// The claim, stated on its own so a failure names it rather than
		// pointing at a list: the guardrail arrives BEFORE the run settles.
		expect(triggered).toBeLessThan(completed)
		expect(completed).toBe(types(events).length - 1)

		// And this is the branch that emitted it.
		expect(events[triggered]).toMatchObject({ stage: 'output', action: 'block' })
		expect(result.stopReason).toBe('output_guardrail')
		expect(result.result).toBe('')
	})

	it('holds the same position when the guardrail rewrites instead of blocking', async () => {
		const { result, events } = await runWithOutputGuardrail({
			responseText: 'the key is AKIAIOSFODNN7EXAMPLE ok',
			guardrails: [secretRedactionGuardrail()],
		})

		// The rewrite branch is a SECOND pair of emit/drain yields in the same
		// block, so it gets its own assertion rather than riding on the
		// block's: the deltas are collapsed here because their count is the
		// mock's chunking, not the ordering under test.
		expect(types(events).filter((type) => type !== 'text_delta')).toEqual([
			'run_started',
			'activity_created',
			'activity_updated',
			'iteration_started',
			'request_envelope',
			'message_started',
			'message_completed',
			'token_usage_updated',
			'activity_updated',
			'iteration_completed',
			'guardrail_triggered',
			'run_completed',
		])

		const triggered = events.findIndex((event) => event.type === 'guardrail_triggered')
		expect(triggered).toBe(types(events).length - 2)
		expect(events[triggered]).toMatchObject({ stage: 'output', action: 'rewrite' })
		expect(result.result).toContain('[REDACTED:aws-access-key]')
		// The rewrite is a correction to a result, not a different outcome.
		expect(result.stopReason).toBe('end_turn')
	})

	it('names no guardrail and carries no reason when a rewrite is reported', async () => {
		const { result, events } = await runWithOutputGuardrail({
			responseText: 'replace me',
			// The rewrite half of `GuardrailVerdict`: a named guardrail whose
			// verdict carries no reason, because the type leaves one optional
			// there and requires one on a block.
			guardrails: [{ name: 'rewriter', check: () => ({ action: 'rewrite', output: 'replaced' }) }],
		})

		const triggered = events.findIndex((event) => event.type === 'guardrail_triggered')
		expect(triggered).toBe(types(events).length - 2)
		const announcement = events[triggered]
		expect(announcement).toMatchObject({ action: 'rewrite' })

		// Both arms take their empty side here, and one of them is a defect
		// worth naming: `runOutputGuardrails` returns
		// `{ blocked: false, rewritten }` for a rewrite — no `name`, no
		// `reason`, unlike the block outcome it returns two lines earlier — so
		// the guardrail's configured name reaches the event only when it
		// BLOCKS. A host reading `guardrail_triggered { action: 'rewrite' }`
		// cannot tell which guardrail rewrote the output. Pinned as it is,
		// not as it should be.
		expect(announcement).not.toHaveProperty('guardrail')
		expect(announcement).not.toHaveProperty('reason')
		expect(result.result).toBe('replaced')
		expect(result.stopReason).toBe('end_turn')
	})
})
