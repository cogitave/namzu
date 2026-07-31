import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { secretRedactionGuardrail } from '../guardrail-presets.js'
import { drainQuery } from '../index.js'

/**
 * Guardrails through the real `query()` path.
 *
 * The unit tests check the runners in isolation; these check that a
 * blocked run actually settles as blocked and never calls the model, and
 * that a rewrite reaches `Run.result` — which is the only thing a host
 * consumes.
 */

const workdirs: string[] = []

afterEach(async () => {
	await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
	workdirs.length = 0
})

async function run(opts: {
	responseText: string
	inputGuardrails?: Parameters<typeof drainQuery>[0]['inputGuardrails']
	outputGuardrails?: Parameters<typeof drainQuery>[0]['outputGuardrails']
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-guardrail-'))
	workdirs.push(workingDirectory)

	const provider = new MockLLMProvider({ turns: [{ text: opts.responseText }] })
	const events: RunEvent[] = []

	const result = await drainQuery(
		{
			provider,
			tools: new ToolRegistry(),
			runConfig: {
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
			sessionId: 'ses_guardrail' as SessionId,
			threadId: 'thd_guardrail' as ThreadId,
			projectId: 'prj_guardrail' as ProjectId,
			tenantId: 'tnt_guardrail' as TenantId,
			...(opts.inputGuardrails ? { inputGuardrails: opts.inputGuardrails } : {}),
			...(opts.outputGuardrails ? { outputGuardrails: opts.outputGuardrails } : {}),
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
			.filter((e): e is Extract<RunEvent, { type: 'text_delta' }> => e.type === 'text_delta')
			.map((e) => e.text)
			.join('')

		expect(streamed).toContain('AKIAIOSFODNN7EXAMPLE')
		expect(result.result).not.toContain('AKIAIOSFODNN7EXAMPLE')
		// …which is exactly why the correction is announced.
		expect(events.some((e) => e.type === 'guardrail_triggered')).toBe(true)
	})
})
