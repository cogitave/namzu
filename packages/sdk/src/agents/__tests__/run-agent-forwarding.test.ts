import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import { runAgent } from '../runAgent.js'

/**
 * The `drainQuery` call in `runAgent` was written `as never`.
 *
 * That cast was not load-bearing — removing it typechecks clean — but while it
 * was there the kernel seam was unchecked in both directions: a field the
 * kernel accepts and this door forgot to forward produced no error, and neither
 * did a field spelled wrong. Two were already missing when it was removed.
 *
 * `skills` is the one with a caller in this repo. `@namzu/project` reads a
 * whole `skills/` directory, put them on the options, and every one was dropped
 * on the floor — the run was assembled without them and said nothing. These
 * pin the forwarding rather than the cast, because the cast can come back and
 * a test that only asserted its absence would not notice.
 */

registerMock()

describe('runAgent forwards what the kernel takes', () => {
	it('puts skills in front of the model', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'plan something',
			skills: [
				{
					metadata: { name: 'plan-a-trip', description: 'Plan a trip end to end' },
					body: 'Ask for dates first.',
					dirPath: '/tmp/skills/plan-a-trip',
				},
			],
		})

		// Serialized rather than reached into: the prompt builder decides where a
		// skill lands, and pinning that path here would make this test fail on a
		// refactor that kept the behaviour. What matters is that it arrived.
		expect(JSON.stringify(provider.requests[0])).toContain('plan-a-trip')
	})

	it('forwards the verification gate, so a denied tool does not run', async () => {
		// The first version of this test asserted `run.status === 'completed'`
		// with the gate set. It passed with the forwarding deleted — a run with
		// no gate completes too — so it proved nothing. A gate is only observable
		// through a call it stops, which means the assertion has to be about
		// whether the tool body ran.
		let ran = false

		const tools = new ToolRegistry()
		tools.register({
			name: 'delete_everything',
			description: 'Deletes everything.',
			inputSchema: z.object({}),
			execute: async () => {
				ran = true
				return { success: true, output: 'deleted' }
			},
		})

		await runAgent({
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'delete_everything', args: {} }] }, { text: 'done' }],
			}),
			model: 'mock-model',
			prompt: 'clean up',
			tools,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'deny_by_name', toolNames: ['delete_everything'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})

		expect(ran).toBe(false)
	})
})
