import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'

/**
 * The unit tests next door prove `attachSteering` builds the right message.
 * They would all pass with the loop never calling it — which is the exact
 * shape of defect this repo keeps finding, and the reason this file drives a
 * real run instead.
 *
 * A steer queued while a tool is running must be visible in the messages the
 * NEXT model call receives, or the channel is another declaration nothing
 * drives.
 */

registerMock()

async function runWithSteer(steerDuringTool?: string) {
	const steering = new SteeringBinding()

	const tools = new ToolRegistry()
	tools.register({
		name: 'inspect',
		description: 'looks at something',
		inputSchema: z.object({}),
		execute: async () => {
			// Queued from inside the tool, which is when a host would type it:
			// the batch is in flight and there is no legal slot for a user
			// message until it settles.
			if (steerDuringTool) steering.steer(steerDuringTool)
			return { success: true, output: 'inspection done' }
		},
	})

	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'inspect', rawArguments: '{}' }] },
			{ text: 'finished' },
		],
	})

	await drainQuery({
		provider,
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		runConfig: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 4,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		steering,
	})

	return { provider, steering }
}

/** Every message body the model saw on its Nth call, flattened to text. */
function bodiesOn(provider: MockLLMProvider, call: number): string {
	return (provider.requests[call]?.messages ?? [])
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n')
}

describe('guidance queued during a tool batch reaches the model', () => {
	it('is in the messages of the next model call', async () => {
		const { provider } = await runWithSteer('actually, check the tests as well')

		expect(provider.requests.length).toBeGreaterThan(1)
		expect(bodiesOn(provider, 1)).toContain('actually, check the tests as well')
	})

	it('rides on the tool result rather than as a separate turn', async () => {
		const { provider } = await runWithSteer('check the tests as well')

		const second = provider.requests[1]?.messages ?? []
		const carrier = second.find((m) =>
			typeof m.content === 'string' ? m.content.includes('check the tests as well') : false,
		)

		// The slot matters: a `tool_use` block must be answered by a
		// `tool_result` with the same id, so a user turn wedged in here is
		// rejected by the provider outright.
		expect(carrier?.role).toBe('tool')
		expect(String(carrier?.content)).toContain('inspection done')
	})

	it('is delivered once and leaves the channel empty', async () => {
		const { steering } = await runWithSteer('one time only')

		expect(steering.pending).toBe(false)
	})

	it('changes nothing when nobody steers', async () => {
		const { provider } = await runWithSteer()

		expect(bodiesOn(provider, 1)).toContain('inspection done')
		expect(bodiesOn(provider, 1)).not.toContain('operator')
	})
})
