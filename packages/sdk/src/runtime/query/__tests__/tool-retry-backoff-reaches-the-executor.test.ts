/**
 * Reachability is its own property.
 *
 * `tool-retry-backs-off.test.ts` drives `ToolExecutor` directly, which proves
 * the backoff and proves nothing about whether a host can ask for one. That
 * hop has been the defect here before: `toolTimeoutMs` and its neighbours sat
 * on `QueryParams` and stopped there, unreachable for anyone using the Agent
 * classes, and a policy a consumer cannot set is a policy that does not exist
 * for them.
 *
 * So this file asks one question — does the value a caller passes arrive in
 * the config `query()` builds the executor from — and answers it structurally
 * rather than by timing anything. A stopwatch would have to sleep to
 * discriminate, and the difference between "reached" and "did not reach" is
 * not a duration; it is a field.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import type { ToolExecutorConfig } from '../executor.js'

/** Every config an executor was constructed with during a run. */
const built: ToolExecutorConfig[] = []

vi.mock('../executor.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../executor.js')>()
	return {
		...actual,
		ToolExecutor: class extends actual.ToolExecutor {
			constructor(...args: ConstructorParameters<typeof actual.ToolExecutor>) {
				built.push(args[0])
				super(...args)
			}
		},
	}
})

const { drainQuery } = await import('../index.js')

function echoTool(): ToolDefinition {
	return {
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	} as unknown as ToolDefinition
}

describe('the tool-retry backoff a caller sets reaches the executor', () => {
	let workdirs: string[] = []

	beforeEach(() => {
		built.length = 0
	})

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function run(extra: Record<string, unknown>) {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-backoff-reach-'))
		workdirs.push(dir)
		const tools = new ToolRegistry()
		tools.register(echoTool())

		return drainQuery({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools,
			runConfig: {
				model: 'run-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
			agentId: 'agent_reach',
			agentName: 'Reach Agent',
			workingDirectory: dir,
			sessionId: 'ses_reach' as SessionId,
			topicId: 'thd_reach' as ThreadId,
			projectId: 'prj_reach' as ProjectId,
			tenantId: 'tnt_reach' as TenantId,
			retry: false as const,
			messages: [createUserMessage('hello')],
			...extra,
		})
	}

	it('carries the policy through to the executor the run builds', async () => {
		await run({ toolRetryBackoff: { initialDelayMs: 0, maxDelayMs: 0 } })

		expect(built.length).toBeGreaterThan(0)
		expect(built[0]?.toolRetryBackoff).toEqual({ initialDelayMs: 0, maxDelayMs: 0 })
	})

	it('leaves it absent when the caller said nothing, so the shipped default applies', async () => {
		// The other half of the same fact. A config that arrived populated
		// whatever the caller passed would satisfy the case above while
		// telling a reader nothing.
		await run({})

		expect(built.length).toBeGreaterThan(0)
		expect(built[0]?.toolRetryBackoff).toBeUndefined()
	})
})
