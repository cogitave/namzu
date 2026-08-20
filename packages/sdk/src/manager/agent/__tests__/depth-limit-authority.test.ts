import { describe, expect, it, vi } from 'vitest'

import type { AgentTaskContext } from '../../../types/agent/index.js'

/**
 * Which `maxDepth` is in force.
 *
 * Two exist. `AgentManagerConfig.maxDepth` is enforced in
 * `AgentManager.sendMessage`; `SupervisorAgentConfig.maxDepth` is read by
 * nothing. For a recursion bound that is the worst way to be wrong — the
 * number a reviewer sees in the supervisor config is not the number
 * stopping runaway delegation.
 *
 * The first version of these tests passed the config where the registry
 * goes, so every case silently ran against the default of 3 — and the case
 * that used 3 "passed" while proving nothing. Configuring a value the
 * default is not is what makes this a test.
 */

async function manager(maxDepth: number) {
	const { AgentManager } = await import('../lifecycle.js')
	const registry = { resolve: vi.fn(), get: vi.fn(), getAll: vi.fn(() => []) }
	const deps = {
		createAgent: vi.fn(),
		taskStore: undefined,
		topicManager: { requireOpen: vi.fn() },
	}
	return new AgentManager(registry as never, { maxDepth }, deps as never)
}

function contextAtDepth(depth: number): AgentTaskContext {
	return {
		parentRunId: 'run_x',
		parentAgentId: 'agent_x',
		parentAbortController: new AbortController(),
		depth,
		tenantId: 'tnt_x',
	} as unknown as AgentTaskContext
}

function send(m: Awaited<ReturnType<typeof manager>>, depth: number) {
	return m.sendMessage(
		{ agentId: 'a', prompt: 'go', tenantId: 'tnt_x' } as never,
		contextAtDepth(depth),
	)
}

describe('the manager owns the recursion bound', () => {
	it('refuses a task at the configured depth', async () => {
		// 5, deliberately not the default of 3: a limit that happens to equal
		// the default cannot tell "configured" from "ignored".
		const mgr = await manager(5)

		await expect(send(mgr, 5)).rejects.toThrow(/Max task depth 5/)
	})

	it('refuses past it too, not only exactly at it', async () => {
		const mgr = await manager(2)

		await expect(send(mgr, 7)).rejects.toThrow(/Max task depth 2/)
	})

	it('reports the depth reached alongside the limit', async () => {
		const mgr = await manager(2)

		// A limit without the current value sends someone to instrument the
		// run to learn how deep it actually got.
		await expect(send(mgr, 4)).rejects.toThrow(/current: 4/)
	})

	it('allows a task below the bound to proceed past this check', async () => {
		const mgr = await manager(5)

		// It gets past the depth gate and fails later on the stubbed
		// registry — which is the point: the gate did not stop it.
		await expect(send(mgr, 1)).rejects.not.toThrow(/Max task depth/)
	})
})
