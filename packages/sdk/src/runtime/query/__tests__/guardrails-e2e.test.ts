import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { readAuditTrail } from '../../../manager/session/turn-recorder.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { secretRedactionGuardrail } from '../guardrail-presets.js'
import { drainQuery } from '../index.js'

/**
 * Guardrails through the real `query()` path.
 *
 * The unit tests check the runners in isolation; these check that a
 * blocked run actually settles as blocked and never calls the model, and
 * that a rewrite reaches `Run.result` — which is the only thing a host
 * consumes.
 *
 * Since LOG-14: a guardrail BLOCK is also a first-class 'refused' entry in
 * the audit trail, not merely the `guardrail_triggered` SessionEvent a host
 * happens to be subscribed to when it fires.
 */

const workdirs: string[] = []
const SESSION = '423aea7e-9557-49e3-8c9e-665e12b79391' as SessionId

function sessionLog(): InMemorySessionLog {
	return new InMemorySessionLog({ sessionId: SESSION })
}

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

async function run(opts: {
	responseText: string
	inputGuardrails?: Parameters<typeof drainQuery>[0]['inputGuardrails']
	outputGuardrails?: Parameters<typeof drainQuery>[0]['outputGuardrails']
	sessionLog?: InMemorySessionLog
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-guardrail-'))
	workdirs.push(workingDirectory)

	const provider = new MockLLMProvider({ turns: [{ text: opts.responseText }] })
	const events: SessionEvent[] = []

	const result = await drainQuery(
		{
			provider,
			tools: new ToolRegistry(),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_guard',
			agentName: 'Guarded Agent',
			messages: [createUserMessage('what is the deploy key?')],
			workingDirectory,
			sessionId: SESSION,
			topicId: '26de5705-2f61-4c2a-8f64-39ff8f8587bb' as TopicId,
			projectId: 'a9382cd4-7476-42e1-bd76-7353d47a3907' as ProjectId,
			tenantId: '108babb0-2135-4a4a-87c4-a7f9a81dfaf7' as TenantId,
			...(opts.inputGuardrails ? { inputGuardrails: opts.inputGuardrails } : {}),
			...(opts.outputGuardrails ? { outputGuardrails: opts.outputGuardrails } : {}),
			...(opts.sessionLog ? { sessionLog: opts.sessionLog } : {}),
		},
		(event) => {
			events.push(event)
		},
	)

	return { result, events, provider }
}

describe('input guardrails through query()', () => {
	it('refuses before the model is called at all', async () => {
		const { result, events, provider } = await run({
			responseText: 'should never be produced',
			inputGuardrails: [
				{ name: 'no-secrets-asked', check: () => ({ action: 'block', reason: 'asked for a key' }) },
			],
		})

		// The cheapest possible refusal: nothing was spent.
		expect(provider.requests).toHaveLength(0)
		expect(result.stopReason).toBe('input_guardrail')
		expect(result.lastError).toContain('asked for a key')

		const triggered = events.find((e) => e.type === 'guardrail_triggered')
		expect(triggered).toMatchObject({ stage: 'input', action: 'block' })
	})

	it('writes the refusal down on its way out, exactly once', async () => {
		// This return used to hand back `getRun()` WITHOUT persisting, so the
		// blocked run's terminal state reached the disk only because the
		// abandoned-consumer path found the run unsettled and settled it — a
		// branch that exists for runs whose consumer walked away, carrying a
		// run whose consumer was still reading.
		const log = sessionLog()

		const { result } = await run({
			responseText: 'should never be produced',
			inputGuardrails: [
				{ name: 'no-secrets-asked', check: () => ({ action: 'block', reason: 'asked for a key' }) },
			],
			sessionLog: log,
		})

		expect(result.status).toBe('completed')
		expect(result.stopReason).toBe('input_guardrail')
		// This turn's own settle, and no second terminal record from anywhere.
		const terminal = (await log.readAll()).entries
			.map((entry) => entry.record)
			.filter((record) => record.type === 'turn_completed')
		expect(terminal).toHaveLength(1)
		expect(terminal[0]).toMatchObject({ stopReason: 'input_guardrail' })
	})

	it('is inert when nothing objects', async () => {
		const { result, provider } = await run({
			responseText: 'all good',
			inputGuardrails: [() => ({ action: 'pass' })],
		})

		expect(provider.requests).toHaveLength(1)
		expect(result.result).toBe('all good')
		expect(result.stopReason).toBe('end_turn')
	})
})

describe('output guardrails through query()', () => {
	it('redacts a leaked credential in the final result', async () => {
		// The failure this exists for: the read that surfaced the secret was
		// legitimate, so every tool gate correctly allowed it.
		const { result, events } = await run({
			responseText: 'The deploy key is AKIAIOSFODNN7EXAMPLE — keep it safe.',
			outputGuardrails: [secretRedactionGuardrail()],
		})

		expect(result.result).not.toContain('AKIAIOSFODNN7EXAMPLE')
		expect(result.result).toContain('[REDACTED:aws-access-key]')
		// The run still succeeded — redaction beats discarding a correct answer.
		expect(result.stopReason).toBe('end_turn')

		const triggered = events.find((e) => e.type === 'guardrail_triggered')
		expect(triggered).toMatchObject({ stage: 'output', action: 'rewrite' })
	})

	it('blocks the result when configured to', async () => {
		const { result, events } = await run({
			responseText: 'AKIAIOSFODNN7EXAMPLE',
			outputGuardrails: [secretRedactionGuardrail({ onMatch: 'block' })],
		})

		expect(result.stopReason).toBe('output_guardrail')
		expect(result.result).toBe('')
		expect(events.find((e) => e.type === 'guardrail_triggered')).toMatchObject({
			stage: 'output',
			action: 'block',
		})
	})

	it('leaves a clean result untouched and emits nothing', async () => {
		const { result, events } = await run({
			responseText: 'the deploy finished cleanly',
			outputGuardrails: [secretRedactionGuardrail()],
		})

		expect(result.result).toBe('the deploy finished cleanly')
		expect(events.some((e) => e.type === 'guardrail_triggered')).toBe(false)
	})

	it('streams the ORIGINAL text before the rewrite lands — the documented caveat', async () => {
		// This is the honest limit of gating the result rather than the
		// stream, and it is asserted rather than hidden: a host that renders
		// text_delta live has already shown the secret, and the rewrite
		// arrives as a correction it must handle.
		const { events, result } = await run({
			responseText: 'key AKIAIOSFODNN7EXAMPLE here',
			outputGuardrails: [secretRedactionGuardrail()],
		})

		const streamed = events
			.filter((e): e is Extract<SessionEvent, { type: 'text_delta' }> => e.type === 'text_delta')
			.map((e) => e.text)
			.join('')

		expect(streamed).toContain('AKIAIOSFODNN7EXAMPLE')
		expect(result.result).not.toContain('AKIAIOSFODNN7EXAMPLE')
		// …which is exactly why the correction is announced.
		expect(events.some((e) => e.type === 'guardrail_triggered')).toBe(true)
	})
})

describe('guardrail blocks are audited (LOG-14)', () => {
	it('an input guardrail block records a refused AuditEvent', async () => {
		const log = sessionLog()
		const { result } = await run({
			responseText: 'should never be produced',
			inputGuardrails: [
				{ name: 'no-secrets-asked', check: () => ({ action: 'block', reason: 'asked for a key' }) },
			],
			sessionLog: log,
		})

		expect(result.stopReason).toBe('input_guardrail')

		const trail = await readAuditTrail(log)
		const refusal = trail.find((e) => e.outcome === 'refused')
		expect(refusal).toMatchObject({
			what: { action: 'guardrail:input', resource: 'no-secrets-asked' },
			reason: 'asked for a key',
		})
	})

	it('an output guardrail block records a refused AuditEvent', async () => {
		const log = sessionLog()
		const { result } = await run({
			responseText: 'AKIAIOSFODNN7EXAMPLE',
			outputGuardrails: [secretRedactionGuardrail({ onMatch: 'block' })],
			sessionLog: log,
		})

		expect(result.stopReason).toBe('output_guardrail')

		const trail = await readAuditTrail(log)
		const refusal = trail.find((e) => e.outcome === 'refused')
		expect(refusal).toMatchObject({
			what: { action: 'guardrail:output', resource: 'secret-redaction' },
		})
	})
})
