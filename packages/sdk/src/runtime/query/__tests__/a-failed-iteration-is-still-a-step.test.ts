/**
 * The turn that failed is the turn the ledger has to keep.
 *
 * `recordStep` had two call sites and both were on success paths, so an
 * iteration that threw recorded a span exception and re-threw with nothing
 * written down. That is the worst shape an evidence record can take: a run
 * ledger complete except on the turns that failed reads as "nothing went
 * wrong" precisely when something did, and a reader cannot tell iteration N
 * failing from iteration N never happening.
 *
 * The assertions below are about the ledger AGAINST A TOTAL wherever they can
 * be — one step per iteration the events announced, and the token sum
 * reconciling with the run's own counter — because the defect was an absence,
 * and an absence is only visible against something that says how much should
 * be there.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PluginHookEvent } from '../../../types/plugin/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

function registerEcho(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

/**
 * A plugin manager that fails one lifecycle event.
 *
 * `applyLifecycleHookResults` turns an `error` result into a throw, which is
 * the cheapest way to fail an iteration at a chosen point: `post_llm_call`
 * lands after the provider answered and its tokens were counted but before
 * any step is recorded, and `iteration_end` lands after the step already is.
 */
function failingAt(event: PluginHookEvent, message: string): PluginLifecycleManager {
	return {
		executeHooks: async (fired: PluginHookEvent) =>
			fired === event ? [{ action: 'error', message }] : [],
	} as unknown as PluginLifecycleManager
}

function baseParams(provider: MockLLMProvider, tools: ToolRegistry, workingDirectory: string) {
	return {
		provider,
		tools,
		runConfig: {
			model: 'run-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_fail',
		agentName: 'Fail Agent',
		workingDirectory,
		sessionId: 'ses_fail' as SessionId,
		threadId: 'thd_fail' as ThreadId,
		projectId: 'prj_fail' as ProjectId,
		tenantId: 'tnt_fail' as TenantId,
		retry: false as const,
	}
}

describe('an iteration that failed still leaves a step', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-failstep-'))
		workdirs.push(dir)
		return dir
	}

	it('records the turn the provider failed on, saying how it ended', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ error: { message: 'upstream refused the request', status: 400 } },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		const failed = run.steps?.at(-1)
		expect(run.steps).toHaveLength(2)
		expect(failed?.stepNumber).toBe(2)
		// How it ended, in the field a reader already sorts by.
		expect(failed?.finishReason).toBe('error')
		// And WHAT went wrong — a step that only said `error` would leave a
		// reader back where they started, re-parsing the run's message.
		expect(failed?.failure?.message).toContain('upstream refused the request')
		expect(failed?.failure?.status).toBe(400)
		expect(failed?.failure?.code).toBe('invalid_request')
		expect(failed?.failure?.retryable).toBe(false)
	})

	it('gives every iteration the events announced an entry in the ledger', async () => {
		// Read off the EVENTS rather than a constant. The events are the other
		// party to the contract `stepNumber` documents itself against, and the
		// defect was that the two disagreed on exactly the failing turn — the
		// one iteration that emitted `iteration_started` and no `_completed`.
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'c2', name: 'echo', rawArguments: '{}' }] },
				{ error: { message: 'the third turn died' } },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, tools, await mkWorkdir()),
				messages: [createUserMessage('hello')],
			},
			(e) => {
				events.push(e)
			},
		)

		const started = events
			.filter((e) => e.type === 'iteration_started')
			.map((e) => (e as { iteration: number }).iteration)

		expect(started).toEqual([1, 2, 3])
		expect(run.steps?.map((s) => s.stepNumber)).toEqual(started)
	})

	it('carries the tokens the failed turn spent, so the ledger still reconciles', async () => {
		// The case the issue is really about: the model was called, the tokens
		// were counted against the run, and then the iteration died. Without a
		// step those tokens belong to nothing, and the gap grows with context
		// length because the expensive turn is the late one.
		const provider = new MockLLMProvider({
			turns: [
				{
					text: 'an answer nobody gets to keep',
					usage: { promptTokens: 400, completionTokens: 40, totalTokens: 440 },
				},
			],
		})

		const run = await drainQuery({
			...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
			pluginManager: failingAt('post_llm_call', 'the audit hook rejected the reply'),
			messages: [createUserMessage('hello')],
		})

		const ledger = (run.steps ?? []).reduce((total, s) => total + s.usage.totalTokens, 0)

		expect(run.tokenUsage.totalTokens).toBe(440)
		// Summed AND named: a ledger that reconciled while attributing the
		// spend to some other step would satisfy the first line alone.
		expect(ledger).toBe(run.tokenUsage.totalTokens)
		expect(run.steps?.map((s) => s.usage.totalTokens)).toEqual([440])
		expect(run.steps?.[0]?.finishReason).toBe('error')
	})

	it('names the message the events carry, on a stream that died part-way', async () => {
		// The correlation a host needs to see what the failed turn produced.
		// `streamProviderTurn` returns the id and a throw means the return
		// never happens, so the loop mints it beforehand — otherwise the one
		// turn whose partial output is worth finding is the one with no id.
		const provider = new MockLLMProvider({
			turns: [{ text: 'a long answer that gets cut off', throwAfterChunks: 1 }],
		})
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [createUserMessage('hello')],
			},
			(e) => {
				events.push(e)
			},
		)

		const announced = events.find((e) => e.type === 'message_started') as
			| { messageId: string }
			| undefined
		const closed = events.find((e) => e.type === 'message_completed') as
			| { messageId: string }
			| undefined

		expect(announced?.messageId).toBeDefined()
		expect(run.steps?.[0]?.messageId).toBe(announced?.messageId)
		// Both ends, so the id is a trail rather than a dangling reference.
		expect(closed?.messageId).toBe(announced?.messageId)
	})

	it('does not report a tool call that never came back as an empty success', async () => {
		// `{output: '', isError: false}` is how the success path fills a call
		// with no outcome, and under a step that says `error` it would claim a
		// tool ran and returned nothing successfully — the same lie one level
		// down as the missing step.
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] }],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			pluginManager: failingAt('post_llm_call', 'rejected before the tools ran'),
			messages: [createUserMessage('hello')],
		})

		const step = run.steps?.[0]
		// What the model asked for is evidence and is kept.
		expect(step?.toolCalls.map((tc) => tc.function.name)).toEqual(['echo'])
		// What came back is nothing, and it says nothing rather than something
		// that reads as success.
		expect(step?.toolResults).toEqual([])
	})

	it('records a cancelled turn as cancelled rather than as a failure', async () => {
		// A Stop is not an error and the step must not call it one — a host
		// counting failures would count every cancellation.
		const controller = new AbortController()
		const provider = new MockLLMProvider({
			turns: [{ text: 'the model was talking when the stop arrived', chunkSize: 4 }],
			onRequest: () => {
				controller.abort()
			},
		})

		const run = await drainQuery({
			...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
			signal: controller.signal,
			messages: [createUserMessage('hello')],
		})

		expect(run.stopReason).toBe('cancelled')
		expect(run.steps).toHaveLength(1)
		expect(run.steps?.[0]?.finishReason).toBe('cancelled')
		expect(run.steps?.[0]?.failure).toBeUndefined()
	})

	it('does not add a second entry when the failure lands after the step', async () => {
		// Both success paths record before the work that follows them, so a
		// throw from the advisory phase or an `iteration_end` hook arrives at
		// a catch whose iteration is already in the ledger. Recording again
		// would double-count that turn against `run.tokenUsage` — the same
		// class of wrong as dropping it, and harder to notice, because the
		// ledger looks fuller rather than emptier.
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }],
					usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 },
				},
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			pluginManager: failingAt('iteration_end', 'the trailing hook blew up'),
			messages: [createUserMessage('hello')],
		})

		expect(run.steps?.map((s) => s.stepNumber)).toEqual([1])
		// The turn's own verdict survives; it really did end in tool calls,
		// and the failure that came afterwards is the run's, not the turn's.
		expect(run.steps?.[0]?.finishReason).toBe('tool_calls')
		expect((run.steps ?? []).reduce((t, s) => t + s.usage.totalTokens, 0)).toBe(
			run.tokenUsage.totalTokens,
		)
	})
})
