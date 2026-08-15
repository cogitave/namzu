import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import { drainQuery } from '../index.js'

/**
 * `effort` was declared on the provider params, exported, and read by a driver
 * that wrote it straight to the wire — and nothing in the kernel ever set it.
 * No caller could reach it, and the symptom (every request going out at the
 * model's default) reads as "this model ignores effort" rather than "nobody
 * plumbed it through".
 *
 * These drive a real run and read what the provider was actually handed, which
 * is the only thing that distinguishes a wired field from a declared one. A
 * test asserting the field exists on the config type would have passed against
 * the broken version.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function run(overrides: Partial<AgentRunConfig>, turns: unknown[]): Promise<MockLLMProvider> {
	const provider = new MockLLMProvider({ turns: turns as never })
	const dir = await mkdtemp(join(tmpdir(), 'namzu-effort-'))
	workdirs.push(dir)

	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			...overrides,
		},
		agentId: 'agent_effort',
		agentName: 'Effort Agent',
		workingDirectory: dir,
		sessionId: 'ses_effort',
		topicId: 'thd_effort',
		projectId: 'prj_effort',
		tenantId: 'tnt_effort',
		messages: [createUserMessage('go')],
	})

	return provider
}

describe('an effort level set on the run reaches the provider', () => {
	it('arrives on the request', async () => {
		const provider = await run({ effort: 'max' }, [{ text: 'done' }])

		expect(provider.requests.length).toBeGreaterThan(0)
		expect(provider.requests[0]?.effort).toBe('max')
	})

	it('is absent when nobody asked for one', async () => {
		// Not `undefined`-valued but genuinely absent: a present key carrying
		// undefined is the kind of thing that survives a spread into a request
		// body and reaches a wire that did not expect the field.
		const provider = await run({}, [{ text: 'done' }])

		expect(provider.requests[0] && 'effort' in provider.requests[0]).toBe(false)
	})

	it('rides every turn of the run, not only the first', async () => {
		// The value is run-level because the provider documents that changing
		// it between requests invalidates the cached prefix. A run that
		// forwarded it once and then stopped would pay that cost silently.
		const provider = await run({ effort: 'low' }, [{ text: 'one' }, { text: 'two' }])

		for (const request of provider.requests) {
			expect(request.effort).toBe('low')
		}
	})

	it('travels alongside thinking rather than inside it', async () => {
		const provider = await run({ effort: 'high', thinking: { type: 'adaptive' } }, [
			{ text: 'done' },
		])

		expect(provider.requests[0]?.effort).toBe('high')
		expect(provider.requests[0]?.thinking?.type).toBe('adaptive')
	})
})

describe('the front door forwards it too, not only the kernel', () => {
	/**
	 * These exist because everything above passed while a real run put NOTHING
	 * on the wire.
	 *
	 * `drainQuery` takes the run config a caller hands it, so testing through
	 * it proves the loop forwards the field and nothing about whether a caller
	 * can set it. Every ergonomic entry point — this one, `ReactiveAgent`,
	 * `SupervisorAgent`, and the manager's bare-config branch — builds its
	 * `AgentRunConfig` by HAND-LISTING fields, so a field nobody remembered to
	 * add is dropped in silence, with no cast to blame and no error to see.
	 * `thinking` had been in that state since it shipped.
	 *
	 * It was found by watching an actual HTTP body, which is the only place the
	 * gap is visible. So the regression test drives the front door.
	 */
	it('reaches the provider through runAgent', async () => {
		const { runAgent } = await import('../../../agents/runAgent.js')
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] as never })
		const dir = await mkdtemp(join(tmpdir(), 'namzu-effort-door-'))
		workdirs.push(dir)

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'go',
			workingDirectory: dir,
			effort: 'xhigh',
			thinking: { type: 'adaptive' },
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
		})

		expect(provider.requests.length).toBeGreaterThan(0)
		expect(provider.requests[0]?.effort, 'the front door dropped effort').toBe('xhigh')
		expect(provider.requests[0]?.thinking?.type, 'the front door dropped thinking').toBe('adaptive')
	})
})
