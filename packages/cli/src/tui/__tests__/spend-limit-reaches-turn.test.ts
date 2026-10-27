import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentEvent, createAgentSession } from '../agent.js'
import { describeTurnInterruption } from '../turn-interruption.js'

/**
 * A spend limit is checked against the priced ledger between model calls. The
 * session is real and the network is faked: a model that keeps asking for
 * tools would run to the iteration cap, so a stop on the limit shows it was
 * read from the session options and enforced.
 */

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'gpt-5.5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

let cwd: string
let calls = 0

function stubProvider(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => {
			calls += 1
			const chunk = {
				id: `chatcmpl-spend-${calls}`,
				object: 'chat.completion.chunk',
				created: 1,
				model: 'gpt-5.5',
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: `call_${calls}`,
									type: 'function',
									function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.nothing' }) },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
				usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
			}
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			})
		}),
	)
}

async function stopReasonWith(
	limits: { costLimitUsd?: number; maxIterations: number },
	choice: { preferences: Preferences; detected: DetectedProvider[] } = { preferences, detected },
) {
	calls = 0
	const session = await createAgentSession(choice.preferences, choice.detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		memory: { recall: false },
		limits,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	let done: Extract<AgentEvent, { kind: 'done' }> | undefined
	let failure: Extract<AgentEvent, { kind: 'error' }> | undefined
	try {
		for await (const event of session.send([createUserMessage('Keep looking')])) {
			if (event.kind === 'done') done = event
			if (event.kind === 'error') failure = event
		}
	} finally {
		await session.close()
	}
	return { stopReason: done?.stopReason, calls, failure }
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-spend-limit-'))
	stubProvider()
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('a spend limit stops the turn on the priced ledger', () => {
	it('stops after the call that passed it', async () => {
		const run = await stopReasonWith({ costLimitUsd: 0.000001, maxIterations: 6 })
		expect(run.stopReason).toBe('cost_limit')
		expect(run.calls).toBe(1)
	})

	it('without a limit the same model runs to the iteration cap', async () => {
		const run = await stopReasonWith({ maxIterations: 3 })
		expect(run.stopReason).toBe('max_iterations')
		expect(run.calls).toBe(3)
	})

	it('refuses a model with no price on file in plain words, before any spend', async () => {
		const unpriced = {
			preferences: {
				version: 3,
				providers: [{ id: 'deepseek' }],
				subagents: { active: [] },
			} satisfies Preferences,
			detected: [
				{
					entry: PROVIDER_REGISTRY.deepseek,
					source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
					apiKey: 'not-a-real-key',
					alternatives: [],
				},
			] satisfies DetectedProvider[],
		}
		const run = await stopReasonWith({ costLimitUsd: 1, maxIterations: 3 }, unpriced)
		expect(run.calls).toBe(0)
		if (!run.failure) throw new Error('the turn should have been refused')
		const text = describeTurnInterruption(run.failure)
		expect(text).toMatch(/no price on file for /)
		expect(text).toMatch(/token limit/)
		expect(text).not.toMatch(/turnConfig|rates\.source|costLimitUsd/)
	})
})
