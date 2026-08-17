import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type LogRecord, ProviderRegistry } from '@namzu/sdk'

import {
	ensureFreshAnthropicToken,
	readSubscriptionCredential,
} from '../../integrations/providers/index.js'
import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import { installCliLogging } from '../../logging.js'
import { createAgentSession } from '../agent.js'

vi.mock('../../integrations/subagents/runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/subagents/runtime.js')>()
	return { ...actual, createSubagentRuntime: vi.fn(actual.createSubagentRuntime) }
})

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		readSubscriptionCredential: vi.fn(actual.readSubscriptionCredential),
		ensureFreshAnthropicToken: vi.fn(actual.ensureFreshAnthropicToken),
	}
})

const detectedAnthropic = {
	entry: {
		id: 'anthropic',
		label: 'Anthropic',
		defaultModel: 'a-model',
		requiresApiKey: true,
		envVars: ['ANTHROPIC_API_KEY'],
	},
	source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
}

const open: { close: () => Promise<void> }[] = []

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
	vi.restoreAllMocks()
	vi.mocked(createSubagentRuntime).mockClear()
	vi.mocked(readSubscriptionCredential).mockReset()
	vi.mocked(ensureFreshAnthropicToken).mockReset()
})

function cwd(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-boot-catch-'))
}

function capturingSink(): LogRecord[] {
	const records: LogRecord[] = []
	installCliLogging({ emit: (r) => records.push(r) }, 'debug')
	return records
}

describe('agent.ts:810 — the sub-agent runtime catch', () => {
	it('warns with exception.type/message when the runtime fails to start, and stays non-fatal', async () => {
		vi.mocked(createSubagentRuntime).mockRejectedValueOnce(new TypeError('subagent runtime boom'))

		const records = capturingSink()
		const s = await createAgentSession(
			{ version: 3, providers: [{ id: 'anthropic' }] } as never,
			[detectedAnthropic] as never,
			{ cwd: cwd() },
		)
		open.push(s)

		expect(s.hasProvider).toBe(true)
		expect(s.agentIds).toEqual([])

		const warned = records.find(
			(r) => r.severityText === 'warn' && r.body === 'sub-agent runtime unavailable this session',
		)
		expect(warned).toBeDefined()
		expect(warned?.attributes['exception.type']).toBe('TypeError')
		expect(warned?.attributes['exception.message']).toBe('subagent runtime boom')
	})
})

describe('agent.ts:713 — the token-refresh rebuild catch', () => {
	it('warns with exception.type/message when rebuilding the client after a refresh fails, and keeps the previous client', async () => {
		vi.mocked(readSubscriptionCredential).mockReturnValue({
			accessToken: 'stale-token',
			refreshToken: 'r',
			expiresAt: 0,
		})
		vi.mocked(ensureFreshAnthropicToken).mockResolvedValue('fresh-token')

		// First `ProviderRegistry.create` call is the session's initial
		// construction (must succeed so the session builds at all); the
		// second is the refresh-triggered rebuild inside the catch under
		// test, which is made to throw.
		let calls = 0
		const createSpy = vi.spyOn(ProviderRegistry, 'create').mockImplementation((() => {
			calls++
			if (calls > 1) throw new TypeError('rebuild boom')
			return { provider: { id: 'anthropic' } }
		}) as never)

		const detectedOAuth = {
			...detectedAnthropic,
			apiKey: 'cc-oauth-token',
			oauth: { origin: 'keychain' as const, refreshToken: 'r', expiresAt: 0 },
		}
		const s = await createAgentSession(
			{ version: 3, providers: [{ id: 'anthropic' }] } as never,
			[detectedOAuth] as never,
			{ cwd: cwd() },
		)
		open.push(s)

		const records = capturingSink()
		// `resumeDurable` calls `refreshTokenIfNeeded()` as its first
		// statement, before anything else — same prelude `send()` runs, and
		// the one reachable from this test without driving a full turn
		// through `query()`. What `resumeRun` itself does with an
		// intentionally-bare fixture afterward is irrelevant to this
		// assertion, hence the swallowed rejection.
		await s
			.resumeDurable({
				entry: { tenantId: 't', projectId: 'p', sessionId: 's' } as never,
				checkpointStore: {} as never,
			})
			.catch(() => {})

		const warned = records.find(
			(r) =>
				r.severityText === 'warn' &&
				r.body === 'provider client rebuild after token refresh failed',
		)
		expect(warned).toBeDefined()
		expect(warned?.attributes['exception.type']).toBe('TypeError')
		expect(warned?.attributes['exception.message']).toBe('rebuild boom')
		expect(calls).toBeGreaterThan(1)

		createSpy.mockRestore()
	})
})
