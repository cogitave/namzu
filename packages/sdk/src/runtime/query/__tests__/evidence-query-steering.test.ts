import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createEvidenceQueryResolver } from '../../../turn/evidence-query.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

it('keeps the current subject when tool-result steering repeats an older question', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-query-steering-'))
	roots.push(workingDirectory)
	const steering = new SteeringBinding()
	const question = 'What was its exact identifier?'
	const resolve = createEvidenceQueryResolver()
	const tools = testToolset({
		name: 'observe',
		description: 'Read-only fixture',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed DELTA.' }),
	})
	const plans: { current: string; history: { text: string }[] }[] = []
	const provider = new MockLLMProvider({
		nextTurn: (params, index) => {
			if (
				String(params.messages[0]?.content).startsWith(
					'Resolve a conversation-history search query.',
				)
			) {
				plans.push(JSON.parse(String(params.messages[1]?.content)))
				return {
					text: JSON.stringify({ mode: 'none', time: 'unspecified', termIds: [], basis: [] }),
				}
			}
			if (index === 0) {
				steering.steer(question)
				return { toolCalls: [{ name: 'observe', args: {} }] }
			}
			return { text: 'Done' }
		},
	})
	const run = await drainQuery({
		provider,
		tools,
		steering,
		workingDirectory,
		agentId: 'query-steering',
		agentName: 'Query steering',
		tenantId: fixtureId.tenant('query-steering'),
		projectId: fixtureId.project('query-steering'),
		sessionId: fixtureId.session('query-steering'),
		topicId: fixtureId.topic('query-steering'),
		messages: [
			createUserMessage('Inspect the ALPHA receipt.'),
			createUserMessage(question),
			createAssistantMessage('The ALPHA inspection finished.'),
			createUserMessage('Inspect the DELTA receipt.'),
		],
		prepareStep: async (context) => {
			if (
				context.latestUserMessage?.source?.type === 'runtime-context' &&
				context.latestUserMessage.source.kind === 'steering'
			)
				await resolve(context, context.latestUserMessage.content)
			return undefined
		},
		turnConfig: { model: 'scripted', maxIterations: 3, tokenBudget: 1000, timeoutMs: 5000 },
	})
	expect(run.stopReason, run.lastError).toBe('end_turn')
	expect(provider.requests).toHaveLength(3)
	expect(plans).toHaveLength(1)
	expect(plans[0]?.current).toBe(question)
	expect(plans[0]?.history.at(-1)?.text).toBe('Inspect the DELTA receipt.')
	expect(run.tokenUsage.totalTokens).toBe(0)
})
