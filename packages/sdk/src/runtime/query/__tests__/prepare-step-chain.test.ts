import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PrepareStepChain } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A single slot is enough for one concern and no help with two. A host
 * with a per-tenant system prefix AND a cost-based model downgrade had to
 * hand-compose them into one callback — which puts the ordering in the
 * host's own code where nothing can see it, and makes each concern's
 * failure the other's problem.
 */

const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
	dirs.length = 0
})

async function run(prepareStep: PrepareStepChain) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-chain-'))
	dirs.push(workingDirectory)

	const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'base-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			temperature: 0.5,
		},
		agentId: 'agent_c',
		agentName: 'Chained',
		messages: [createUserMessage('do the work')],
		workingDirectory,
		sessionId: 'ses_c' as SessionId,
		threadId: 'thd_c' as ThreadId,
		projectId: 'prj_c' as ProjectId,
		tenantId: 'tnt_c' as TenantId,
		prepareStep,
	})

	return provider.requests[0]
}

describe('several shaping stages', () => {
	it('applies every stage, so two concerns do not have to be one callback', async () => {
		const sent = await run([() => ({ model: 'cheap-model' }), () => ({ temperature: 0.1 })])

		expect(sent?.model).toBe('cheap-model')
		expect(sent?.temperature).toBe(0.1)
	})

	it('lets a later stage override an earlier one, in declaration order', async () => {
		// Last writer wins — visibly, because the order is a line in the
		// host's code rather than an accident of install history.
		const sent = await run([() => ({ model: 'first' }), () => ({ model: 'second' })])

		expect(sent?.model).toBe('second')
	})

	it('shows a stage what the ones before it decided', async () => {
		// Reading the accumulated decision is how a later stage REFINES an
		// earlier one instead of guessing at it.
		const seen: unknown[] = []
		const sent = await run([
			() => ({ model: 'downgraded' }),
			(context) => {
				seen.push(context.prepared)
				return context.prepared.model === 'downgraded' ? { temperature: 0 } : {}
			},
		])

		expect(seen[0]).toMatchObject({ model: 'downgraded' })
		expect(sent?.temperature).toBe(0)
	})

	it('starts the first stage with nothing decided', async () => {
		const seen: unknown[] = []
		await run([
			(context) => {
				seen.push(context.prepared)
				return {}
			},
		])

		expect(seen[0]).toEqual({})
	})

	it('keeps running the rest when one stage throws', async () => {
		// One broken concern must not silently disable the others it was
		// declared beside.
		const sent = await run([
			() => {
				throw new Error('this stage is broken')
			},
			() => ({ model: 'still-applied' }),
		])

		expect(sent?.model).toBe('still-applied')
	})

	it('still accepts a single function, unchanged', async () => {
		const sent = await run(() => ({ model: 'solo' }))

		expect(sent?.model).toBe('solo')
	})

	it('treats an empty list as no shaping at all', async () => {
		const sent = await run([])

		expect(sent?.model).toBe('base-model')
		expect(sent?.temperature).toBe(0.5)
	})
})
