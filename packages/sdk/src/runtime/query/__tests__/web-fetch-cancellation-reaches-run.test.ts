import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { GuardedFetchProvider } from '../../../connector/web/guarded-fetch.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { WebFetchTool } from '../../../tools/builtins/web.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The guarded provider can honour cancellation perfectly while the model-facing
 * tool still drops the executor signal. Drive the public tool through a real
 * query and observe the private network transport, not a helper invocation.
 */
describe('guarded web fetch cancellation reaches a real run', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('stops the fetch transport with the run cancellation cause', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-web-fetch-cancel-'))
		workdirs.push(workingDirectory)

		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let transportSignal: AbortSignal | undefined
		const fetch = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					transportSignal = init?.signal as AbortSignal
					transportSignal.addEventListener(
						'abort',
						() =>
							reject(
								Object.assign(new Error('generic transport abort'), {
									name: 'AbortError',
								}),
							),
						{ once: true },
					)
					markStarted?.()
				}),
		) as unknown as typeof globalThis.fetch

		const guarded = new GuardedFetchProvider({
			fetch,
			resolve: async () => ['93.184.216.34'],
			timeoutMs: 1_000,
		})
		const tools = new ToolRegistry()
		tools.register(WebFetchTool)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_web_fetch',
							name: 'web_fetch',
							args: { url: 'https://example.com/' },
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'the stopped run must not need another model turn' },
			],
		})
		const caller = new AbortController()
		const pending = drainQuery({
			provider,
			tools,
			web: { fetch: guarded },
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				permissionMode: 'auto',
			},
			toolTimeoutMs: 60_000,
			agentId: 'agent_web_fetch_cancel',
			agentName: 'Web Fetch Cancellation',
			messages: [createUserMessage('fetch the page')],
			workingDirectory,
			sessionId: 'ses_web_fetch_cancel' as SessionId,
			topicId: 'top_web_fetch_cancel' as TopicId,
			projectId: 'prj_web_fetch_cancel' as ProjectId,
			tenantId: 'tnt_web_fetch_cancel' as TenantId,
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped web retrieval')
		caller.abort(reason)
		let safetyTimer: ReturnType<typeof setTimeout> | undefined
		const run = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				safetyTimer = setTimeout(
					() => reject(new Error('web fetch cancellation did not settle the run')),
					500,
				)
			}),
		]).finally(() => {
			if (safetyTimer) clearTimeout(safetyTimer)
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(transportSignal).toBeDefined()
		expect(transportSignal).not.toBe(caller.signal)
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(reason)
	})
})
