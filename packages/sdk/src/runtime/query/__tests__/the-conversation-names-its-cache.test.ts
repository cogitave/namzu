/**
 * Every request a conversation makes names the same cache.
 *
 * A driver with a cache-routing field sends `cacheKey`; the runtime has to
 * hand it the one id the whole conversation shares, on the main request and
 * on every later step, or the cache cannot be found again.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

const SESSION = '8454c61f-e508-4890-8aeb-04697ca304c0' as SessionId

describe('the request names its conversation', () => {
	let dirs: string[] = []
	afterEach(async () => {
		await removeTempDirs(dirs)
		dirs = []
	})

	it('sends the session id as the cache key on every step', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-cachekey-'))
		dirs.push(dir)
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] }, { text: 'done' }],
		})
		const echo: ToolDefinition = {
			name: 'echo',
			description: 'Echo the text back.',
			inputSchema: z.object({}),
			execute: async () => ({ success: true, output: 'ok' }),
		}
		await drainQuery({
			provider,
			toolsets: [testToolset(echo)],
			turnConfig: {
				model: 'run-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_cache',
			agentName: 'Cache Agent',
			workingDirectory: dir,
			sessionId: SESSION,
			topicId: '1c50dba0-29e5-4831-a6cb-40db4762fc08' as TopicId,
			projectId: '56565325-bc46-4cec-9996-009317a06a3d' as ProjectId,
			tenantId: '789b0bf1-9d8a-40b0-9476-1699ce591d09' as TenantId,
			retry: false as const,
			messages: [createUserMessage('hello')],
		})
		const keys = provider.requests.map((request) => request.cacheKey)
		expect(keys.length).toBeGreaterThanOrEqual(2)
		expect(new Set(keys)).toEqual(new Set([SESSION]))
	})
})
