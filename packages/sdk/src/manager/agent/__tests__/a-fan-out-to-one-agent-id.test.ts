import { describe, expect, it } from 'vitest'

import { ReactiveAgent } from '../../../agents/ReactiveAgent.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'

/**
 * A fan-out naming the same agent four times ran one child and lost three.
 *
 * `AgentRegistry` hands out ONE `typedAgent` per registered id, and an instance
 * refuses a second concurrent `run` — correctly, because its abort controller
 * and run id are instance state and two overlapping runs would cancel each
 * other. So four `create_task` calls at one specialist produced one result and
 * three `ConcurrentInvocationError`s.
 *
 * The prescribed remedy already existed in the docs — "a host that wants
 * parallelism constructs a second instance" — and was unreachable from
 * delegation, where the definition owns the instance and the caller has only an
 * id. Observed live on published 12.0.1: four launches, three lost.
 *
 * These cover the shell itself. That the manager USES it per spawn is covered
 * where the manager is driven; what has to hold here is that asking for a
 * per-run shell gives you a genuinely separate one.
 */

const metadata = {
	id: 'worker',
	name: 'worker',
	version: '1.0.0',
	category: 'general',
	description: 'a worker',
}

describe('an agent can hand out a shell a single run has to itself', () => {
	it('returns a different instance', () => {
		const agent = new ReactiveAgent(metadata)

		expect(agent.forRun()).not.toBe(agent)
	})

	it('keeps the identity, because it is the same agent', () => {
		const agent = new ReactiveAgent(metadata)
		const shell = agent.forRun()

		expect(shell.metadata.id).toBe('worker')
		expect(shell.type).toBe(agent.type)
		expect(shell.getCapabilities()).toEqual(agent.getCapabilities())
	})

	it('gives each shell its own invocation lock, which is the whole point', async () => {
		// Locking one must not lock the other. Asserted through the public
		// surface: a run that never settles holds the lock, and a second run on
		// a SEPARATE shell must still be admitted.
		// ONE registered agent, two shells — the registry's shape, and the
		// shape the fan-out actually hits.
		const registered = new ReactiveAgent(metadata)
		const first = registered.forRun()
		const second = registered.forRun()

		// A provider that starts and never finishes, so each run holds its
		// shell's lock for the duration of the assertion.
		const provider = {
			// biome-ignore lint/correctness/useYield: it never produces anything, on purpose
			async *chatStream() {
				await new Promise<never>(() => {})
			},
		}
		const config = {
			model: 'mock',
			tokenBudget: 10_000,
			timeoutMs: 10_000,
			maxIterations: 2,
			provider,
			tools: new ToolRegistry(),
			systemPrompt: 'hold',
			sessionId: 'ses_fan' as never,
			topicId: 'top_fan' as never,
			projectId: 'prj_fan' as never,
			tenantId: 'tnt_fan' as never,
		}

		// Start one run on each shell; neither resolves, and neither should
		// refuse. A shared shell would reject the second synchronously.
		const a = first.run({ messages: [], workingDirectory: '/tmp' } as never, config as never)
		const b = second.run({ messages: [], workingDirectory: '/tmp' } as never, config as never)

		await expect(
			Promise.race([
				Promise.all([a, b]).then(() => 'settled'),
				new Promise((r) => setTimeout(() => r('still running'), 50)),
			]),
		).resolves.toBe('still running')

		void a.catch(() => {})
		void b.catch(() => {})
	})

	it('a definition may override the shell with its own factory', () => {
		// The escape hatch for an agent that needs real construction
		// arguments, which `forRun`'s metadata-only rebuild cannot supply.
		let built = 0
		const definition: AgentDefinition = {
			info: { ...metadata, tools: [], defaults: {} } as never,
			typedAgent: new ReactiveAgent(metadata) as never,
			createAgent: () => {
				built += 1
				return new ReactiveAgent(metadata) as never
			},
		}

		const one = definition.createAgent?.()
		const two = definition.createAgent?.()

		expect(built).toBe(2)
		expect(one).not.toBe(two)
		expect(one).not.toBe(definition.typedAgent)
	})
})
