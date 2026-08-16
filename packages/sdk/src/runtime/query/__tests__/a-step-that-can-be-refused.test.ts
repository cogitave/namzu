import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { BeforeStep, RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A host could reshape a step and could not refuse one.
 *
 * `prepareStep` changes `activeTools`, `model`, `system`, `temperature` —
 * and cannot reject. `StopCondition` reads `steps`, so it fires only after
 * the step it disliked has already run and been paid for. The one
 * remaining path was a durable checkpoint built for HUMAN review of tool
 * calls, which pauses the run and waits for a person.
 *
 * None of those is what a host with a live rate limit, a revoked tenant or
 * a spend ceiling has. They need the provider call not to happen.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** Counts the provider calls, so "the step did not happen" is measurable. */
class CountingProvider extends MockLLMProvider {
	calls = 0
	constructor() {
		// Tool calls, so the loop reaches a SECOND step. A text-only turn
		// ends the run after one iteration and the veto never gets a chance —
		// which is a fixture that proves nothing, not a passing hook.
		super({
			turns: [
				{ toolCalls: [{ id: 't1', name: 'noop', args: {} }], finishReason: 'tool_calls' },
				{ toolCalls: [{ id: 't2', name: 'noop', args: {} }], finishReason: 'tool_calls' },
				{ text: 'done' },
			],
		})
	}
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls += 1
		yield* super.chatStream(params)
	}
}

async function run(opts: {
	readonly beforeStep?: BeforeStep
	readonly maxIterations?: number
}): Promise<{
	provider: CountingProvider
	run: Awaited<ReturnType<typeof drainQuery>>
	events: RunEvent[]
}> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-veto-'))
	dirs.push(workingDirectory)
	const provider = new CountingProvider()
	const events: RunEvent[] = []

	const result = await drainQuery(
		{
			provider,
			tools: new ToolRegistry(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: opts.maxIterations ?? 4,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: 'ses_v' as SessionId,
			topicId: 'top_v' as TopicId,
			projectId: 'prj_v' as ProjectId,
			tenantId: 'tnt_v' as TenantId,
			...(opts.beforeStep ? { beforeStep: opts.beforeStep } : {}),
		},
		(event: RunEvent) => {
			events.push(event)
		},
	)

	return { provider, run: result, events }
}

describe('a host can refuse the next model call', () => {
	it('stops before the provider is called again', async () => {
		// The measurable claim: one request, not two-and-discard. A veto that
		// ran after the call would still report `step_refused` and would have
		// paid for the step it refused.
		const { provider, run: settled } = await run({
			beforeStep: ({ stepNumber }) =>
				stepNumber >= 2 ? { reason: 'tenant over its rate limit' } : undefined,
		})

		expect(provider.calls).toBe(1)
		expect(settled.stopReason).toBe('step_refused')
	})

	it('records the reason, because a refusal without one is not an answer', async () => {
		const { run: settled } = await run({
			beforeStep: () => ({ reason: 'tenant over its rate limit' }),
		})

		expect(settled.lastError).toContain('tenant over its rate limit')
	})

	it('fails CLOSED when the hook throws', async () => {
		// The opposite of `prepareStep`, deliberately. A broken step-shaper
		// skipped costs a run its tuning; a broken step-refuser skipped is a
		// refusal that did not happen, which is the whole point of the hook.
		const { provider, run: settled } = await run({
			beforeStep: () => {
				throw new Error('the rate-limit service is down')
			},
		})

		expect(settled.stopReason).toBe('step_refused')
		expect(settled.lastError).toContain('the rate-limit service is down')
		expect(provider.calls).toBe(0)
	})

	it('leaves prepareStep failing OPEN, so the two polarities are pinned together', async () => {
		// Asserted in the same file as the case above, because the value is
		// in the CONTRAST: read either alone and the other looks like a bug.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-veto-'))
		dirs.push(workingDirectory)
		const provider = new CountingProvider()

		const settled = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: 'ses_v' as SessionId,
			topicId: 'top_v' as TopicId,
			projectId: 'prj_v' as ProjectId,
			tenantId: 'tnt_v' as TenantId,
			prepareStep: () => {
				throw new Error('a broken shaper')
			},
		})

		expect(settled.stopReason).not.toBe('step_refused')
		expect(provider.calls).toBeGreaterThan(0)
	})

	it('is inert when absent', async () => {
		// The hook must cost a run that does not use it nothing at all — not
		// an extra event, not a different stop reason.
		const withHook = await run({ beforeStep: () => undefined })
		const without = await run({})

		expect(withHook.events.map((e) => e.type)).toEqual(without.events.map((e) => e.type))
		expect(withHook.run.stopReason).toBe(without.run.stopReason)
		expect(withHook.provider.calls).toBe(without.provider.calls)
	})
})
