import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DiskCheckpointStore } from '../../../store/run/checkpoint-disk.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import type { RepairToolCall } from '../../../types/tool/repair.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { drainQuery } from '../index.js'

/**
 * Four defects that every unit test in this repo missed for the same
 * reason: the tests construct the internal class directly, so they prove
 * the helper works and prove nothing about whether `query()` ever reaches
 * it.
 *
 * Each test here goes through the public entry point and would have caught
 * its defect. That is the only property that makes them worth having.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-seam-'))
	dirs.push(dir)
	return dir
}

function countingTool(name: string, calls: string[]): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({ id: z.number() }),
		isDestructive: () => true,
		execute: (input: unknown) => {
			calls.push(`${name}:${(input as { id: number }).id}`)
			return Promise.resolve({ success: true, output: 'ok' })
		},
	} as unknown as ToolDefinition
}

function baseParams(opts: {
	dir: string
	tools: ToolRegistry
	provider: MockLLMProvider
	resumeHandler?: ResumeHandler
}) {
	return {
		provider: opts.provider,
		tools: opts.tools,
		...(opts.resumeHandler ? { resumeHandler: opts.resumeHandler } : {}),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_seam',
		agentName: 'Seam',
		workingDirectory: opts.dir,
		sessionId: 'ses_seam' as SessionId,
		topicId: 'thd_seam' as ThreadId,
		projectId: 'prj_seam' as ProjectId,
		tenantId: 'tnt_seam' as TenantId,
	}
}

describe('query() actually reaches repairToolCall', () => {
	it('repairs a malformed call issued through the real entry point', async () => {
		// The bug: `repairToolCall` was spread into `ToolingBootstrap.init`,
		// whose config type has no such field and whose `init` enumerates
		// what it forwards. Object spread bypasses excess-property checking,
		// so `query({ repairToolCall })` type-checked and did nothing.
		const dir = await workdir()
		const calls: string[] = []
		const tools = new ToolRegistry()
		tools.register(countingTool('delete_row', calls))

		const repair = vi.fn<RepairToolCall>(() => ({ arguments: '{"id":42}' }))
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', rawArguments: '{"id": 4' }] }, { text: 'done' }],
		})

		await drainQuery({
			...baseParams({ dir, tools, provider }),
			messages: [createUserMessage('delete row 42')],
			repairToolCall: repair,
		})

		expect(repair).toHaveBeenCalled()
		expect(calls).toEqual(['delete_row:42'])
	})
})

describe('a post_tool_use retry works on a tool that did not opt into retries', () => {
	it('honors the hook once, then stops', async () => {
		// The bug: `post.retry` was read inside a loop bounded by the tool's
		// `maxRetries`, which defaults to 0 — so the loop body never ran and
		// the hook's answer was silently discarded. `retry` had also been
		// removed from the unsupported-action throw, so plugin authors got
		// silence instead of an error.
		const dir = await workdir()
		const calls: string[] = []
		const tools = new ToolRegistry()
		tools.register(countingTool('flaky', calls))

		let asked = 0
		const pluginManager = {
			executeHooks: (event: string) => {
				if (event !== 'post_tool_use') return Promise.resolve([] as PluginHookResult[])
				asked++
				// Ask for exactly one retry, then let it settle.
				return Promise.resolve(
					asked === 1
						? ([{ action: 'retry' }] as PluginHookResult[])
						: ([{ action: 'continue' }] as PluginHookResult[]),
				)
			},
		}

		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'flaky', args: { id: 1 } }] }, { text: 'done' }],
		})

		await drainQuery({
			...baseParams({ dir, tools, provider }),
			messages: [createUserMessage('go')],
			pluginManager: pluginManager as never,
		})

		// Ran twice: the original call plus the hook-requested retry.
		expect(calls).toEqual(['flaky:1', 'flaky:1'])
	})

	it('a hook that always asks for a retry cannot spin the executor', async () => {
		const dir = await workdir()
		const calls: string[] = []
		const tools = new ToolRegistry()
		tools.register(countingTool('flaky', calls))

		const pluginManager = {
			executeHooks: (event: string) =>
				Promise.resolve(
					event === 'post_tool_use'
						? ([{ action: 'retry' }] as PluginHookResult[])
						: ([] as PluginHookResult[]),
				),
		}

		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'flaky', args: { id: 1 } }] }, { text: 'done' }],
		})

		await drainQuery({
			...baseParams({ dir, tools, provider }),
			messages: [createUserMessage('go')],
			pluginManager: pluginManager as never,
		})

		// Bounded by HOOK_RETRY_BUDGET, not unbounded.
		expect(calls).toHaveLength(2)
	})
})

describe('a cross-process resume clears the park it acted on', () => {
	it('stops reporting pending once the approved batch has run', async () => {
		// The bug: `applyPendingResume` executed the batch and returned. The
		// checkpoint kept `pending` with no `resolvedAt`, so an approval
		// queue built on `findPendingCheckpoint` re-served a destructive call
		// that had already run — the exact failure recording the park exists
		// to prevent.
		const dir = await workdir()
		const calls: string[] = []
		const tools = new ToolRegistry()
		tools.register(countingTool('delete_row', calls))
		const store = new DiskCheckpointStore({ baseDir: join(dir, 'runs') })
		const scope = {
			tenantId: 'tnt_seam' as TenantId,
			projectId: 'prj_seam' as ProjectId,
			sessionId: 'ses_seam' as SessionId,
			runId: 'run_seam' as RunId,
		}

		const pauseOnReview: ResumeHandler = (request) =>
			Promise.resolve(
				request.type === 'tool_review'
					? ({ action: 'pause', reason: 'ask a human' } as HITLResumeDecision)
					: ({ action: 'continue' } as HITLResumeDecision),
			)

		const parked = await drainQuery({
			...baseParams({
				dir,
				tools,
				provider: new MockLLMProvider({
					turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 9 } }] }],
				}),
				resumeHandler: pauseOnReview,
			}),
			checkpointStore: store,
			runId: scope.runId,
			messages: [createUserMessage('delete row 9')],
		})

		const pending = await findPendingCheckpoint(store, { ...scope, runId: parked.id })
		expect(pending).not.toBeNull()

		await drainQuery({
			...baseParams({
				dir,
				tools,
				provider: new MockLLMProvider({ turns: [{ text: 'gone' }] }),
				resumeHandler: pauseOnReview,
			}),
			checkpointStore: store,
			runId: scope.runId,
			messages: [],
			resumeFromCheckpoint: pending?.id,
			pendingDecision: { action: 'approve_tools' },
		})

		expect(calls).toEqual(['delete_row:9'])
		// The queue must not offer this decision again.
		expect(await findPendingCheckpoint(store, { ...scope, runId: parked.id })).toBeNull()
	})
})

describe('configuring an output guardrail does not rewrite the run outcome', () => {
	it('leaves a cancelled run cancelled', async () => {
		// The bug: the guardrail branch called `markCompleted()` purely to
		// materialize the produced text, so merely ADDING a safety check
		// turned a cancelled run into a completed one.
		const dir = await workdir()
		const tools = new ToolRegistry()
		const controller = new AbortController()

		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'noop', args: {} }] }, { text: 'never' }],
		})

		const cancelOnReview: ResumeHandler = () => {
			controller.abort()
			return Promise.resolve({ action: 'abort', reason: 'user stopped' } as HITLResumeDecision)
		}

		const result = await drainQuery({
			...baseParams({ dir, tools, provider, resumeHandler: cancelOnReview }),
			messages: [createUserMessage('go')],
			signal: controller.signal,
			outputGuardrails: [() => ({ action: 'pass' })],
		})

		expect(result.status).toBe('cancelled')
		expect(result.stopReason).toBe('cancelled')
	})

	it('still settles a normal run as completed', async () => {
		const dir = await workdir()
		const tools = new ToolRegistry()
		const result = await drainQuery({
			...baseParams({
				dir,
				tools,
				provider: new MockLLMProvider({ turns: [{ text: 'all good' }] }),
			}),
			messages: [createUserMessage('go')],
			outputGuardrails: [() => ({ action: 'pass' })],
		})

		expect(result.status).toBe('completed')
		expect(result.result).toBe('all good')
	})
})
