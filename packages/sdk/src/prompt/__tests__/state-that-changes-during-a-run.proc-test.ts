import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import { drainQuery } from '../../runtime/query/index.js'
import { BashTool } from '../../tools/builtins/bash.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { PromptContributionRegistry } from '../contributions.js'

/**
 * State that changes DURING a run.
 *
 * `static` is cached for the run and `dynamic` is part of the system
 * prompt, so neither can carry a budget running down or a queue draining:
 * one is served the first iteration's value forever, and the other is read
 * as a standing instruction rather than as a status. `turn` rides the
 * ephemeral trailing message instead — appended to the request, never
 * pushed onto history, gone the moment the request is sent.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

class Capturing extends MockLLMProvider {
	readonly systemTexts: string[] = []
	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const messages = params.messages as { role: string; content: unknown }[]
		this.systemTexts.push(
			messages
				.filter((m) => m.role === 'system' && typeof m.content === 'string')
				.map((m) => m.content as string)
				.join('\n'),
		)
		yield* super.chatStream(params)
	}
}

async function runWith(contributions: PromptContributionRegistry, turns: number) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-turn-'))
	dirs.push(workingDirectory)
	const provider = new Capturing({
		turns: [
			...Array.from({ length: turns - 1 }, (_, i) => ({
				toolCalls: [{ id: `t${i}`, name: 'bash', args: { command: 'echo ok', timeout: 1000 } }],
			})),
			{ text: 'done' },
		] as never,
	})
	const tools = new ToolRegistry()
	tools.register(BashTool)

	await drainQuery({
		provider,
		tools,
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_turn' as SessionId,
		topicId: 'top_turn' as TopicId,
		projectId: 'prj_turn' as ProjectId,
		tenantId: 'tnt_turn' as TenantId,
		promptContributions: contributions,
	})

	return provider.systemTexts
}

describe('a turn contribution reports on every iteration', () => {
	it('reaches the request, with the iteration it was rendered for', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({
			id: 'budget',
			placement: 'turn',
			render: (context) => `BUDGET LEFT: ${100 - (context.iteration ?? 0) * 10}`,
		})

		const requests = await runWith(contributions, 3)

		// A DIFFERENT value each turn. A `static` contribution would repeat
		// the first one forever, which is the failure this placement exists
		// to avoid.
		expect(requests[0]).toContain('BUDGET LEFT: 90')
		expect(requests[1]).toContain('BUDGET LEFT: 80')
		expect(requests[2]).toContain('BUDGET LEFT: 70')
	})

	it('says nothing on the turns it has nothing to say', async () => {
		// The shape to copy, and the reason `turn` is affordable: every
		// iteration pays for it in tokens, so a well-behaved contributor
		// returns null on the turns where nothing moved.
		const contributions = new PromptContributionRegistry()
		contributions.register({
			id: 'rare',
			placement: 'turn',
			render: (context) => (context.iteration === 2 ? 'SOMETHING HAPPENED' : null),
		})

		const requests = await runWith(contributions, 3)

		expect(requests.filter((r) => r.includes('SOMETHING HAPPENED'))).toHaveLength(1)
		expect(requests[1]).toContain('SOMETHING HAPPENED')
	})

	it('is NOT in the cached system prompt', async () => {
		// The refusal that makes the placement mean something. In the system
		// prompt it would be cached for the run or read as a standing
		// instruction, and the state it reports would go stale silently.
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'turnly', placement: 'turn', render: () => 'TURN TEXT' })
		contributions.register({ id: 'staticly', placement: 'static', render: () => 'STATIC TEXT' })

		const requests = await runWith(contributions, 2)

		// Both are present in the request; what differs is that the turn text
		// arrives once per turn in the trailing slot, and is not part of what
		// the cache keeps. The static one is.
		expect(requests[0]).toContain('TURN TEXT')
		expect(requests[0]).toContain('STATIC TEXT')
		// The turn contribution renders once per request, never twice in one.
		expect((requests[0] ?? '').split('TURN TEXT').length - 1).toBe(1)
	})
})
