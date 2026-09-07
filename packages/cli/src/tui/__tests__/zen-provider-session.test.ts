/** CLI provider requests retain the actual conversation across turns and resume. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	InMemoryCheckpointStore,
	type LLMProvider,
	MockLLMProvider,
	ProviderRegistry,
	type QueryParams,
	type ResumeRunParams,
	createUserMessage,
	generateCheckpointId,
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { applyProviderFlags } from '../../commands/run-flags.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'

const queryCalls: QueryParams[] = []
const resumeCalls: ResumeRunParams[] = []
const compactionCalls: Parameters<typeof import('@namzu/sdk')['compactNow']>[0][] = []
const providerConfigurations = new WeakMap<LLMProvider, unknown>()

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: QueryParams) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
		resumeRun: async (params: ResumeRunParams) => {
			resumeCalls.push(params)
			return { resumed: false, reason: 'no-checkpoint' }
		},
		compactNow: async (params: (typeof compactionCalls)[number]) => {
			compactionCalls.push(params)
			return null
		},
	}
})

// Real registration/import agreement is covered by providers/register.test.ts.
// Keep this witness at the CLI → SDK boundary without any transport calls.
vi.mock('../../integrations/providers/register.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/register.js')>()
	return {
		...actual,
		ensureRegistered: async () => {},
		isRegistered: () => true,
		resolveChainCapabilities: async () => [],
	}
})

let cwd: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-service-session-'))
	queryCalls.length = 0
	resumeCalls.length = 0
	compactionCalls.length = 0
	vi.spyOn(ProviderRegistry, 'create').mockImplementation((config) => {
		const provider = new MockLLMProvider()
		providerConfigurations.set(provider, config)
		return { provider, capabilities: {} } as never
	})
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
})

function detected(id: 'zen' | 'zen-go'): DetectedProvider {
	return {
		entry: PROVIDER_REGISTRY[id],
		source: { kind: 'env', envName: PROVIDER_REGISTRY[id].envVars[0] ?? '' },
		apiKey: `${id}-test-credential`,
		baseUrl: PROVIDER_REGISTRY[id].defaultBaseUrl,
		alternatives: [],
	}
}

function scope() {
	return {
		sessionId: generateSessionId(),
		projectId: generateProjectId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
}

it.each(['zen', 'zen-go'] as const)(
	'carries headless --provider %s and --model through to the request',
	async (id) => {
		const { createAgentSession } = await import('../agent.js')
		const currentScope = scope()
		const preferences = applyProviderFlags(
			{ version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } },
			{ provider: id, model: 'kimi-k2.6' },
		)
		const session = await createAgentSession(preferences, [detected(id)], {
			cwd,
			scope: currentScope,
		})
		try {
			expect(session.hasProvider, session.errorHint ?? '').toBe(true)
			for await (const event of session.send([createUserMessage('hello')])) {
				if (event.kind === 'error') throw new Error(event.message)
			}
			expect(queryCalls).toHaveLength(1)
			const request = queryCalls[0]
			expect(request?.runConfig?.model).toBe('kimi-k2.6')
			expect(request?.provider && providerConfigurations.get(request.provider)).toEqual({
				type: id,
				apiKey: `${id}-test-credential`,
				baseURL: PROVIDER_REGISTRY[id].defaultBaseUrl,
				model: 'kimi-k2.6',
				sessionId: currentScope.sessionId,
			})
		} finally {
			await session.close()
		}
	},
)

it('binds primary, fallback, compaction and durable resume to their conversation', async () => {
	const { createAgentSession } = await import('../agent.js')
	const currentScope = scope()
	const originalSessionId = currentScope.sessionId
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'zen-go' }, { id: 'zen' }],
		subagents: { active: [] },
	}
	const session = await createAgentSession(preferences, [detected('zen-go'), detected('zen')], {
		cwd,
		scope: currentScope,
	})
	try {
		expect(session.hasProvider, session.errorHint ?? '').toBe(true)
		const send = async () => {
			for await (const event of session.send([createUserMessage('hello')])) {
				if (event.kind === 'error') throw new Error(event.message)
			}
		}
		await send()
		await send()
		// The TUI materializes, resumes and forks by updating this shared scope.
		currentScope.sessionId = generateSessionId()
		await send()
		expect(queryCalls).toHaveLength(3)
		for (const [index, request] of queryCalls.entries()) {
			const sessionId = index < 2 ? originalSessionId : currentScope.sessionId
			expect(providerConfigurations.get(request.provider)).toMatchObject({
				type: 'zen-go',
				sessionId,
			})
			expect(request.fallbackProviders).toHaveLength(1)
			const fallback = request.fallbackProviders?.[0]
			expect(fallback && providerConfigurations.get(fallback.provider)).toMatchObject({
				type: 'zen',
				sessionId,
			})
		}
		await session.compact([createUserMessage('summarize')])
		expect(compactionCalls).toHaveLength(1)
		const compact = compactionCalls[0]
		expect(compact && providerConfigurations.get(compact.provider)).toMatchObject({
			type: 'zen-go',
			sessionId: currentScope.sessionId,
		})
		await session.resumeDurable({
			entry: {
				...currentScope,
				sessionId: originalSessionId,
				runId: generateRunId(),
				checkpointCount: 1,
				latestCheckpointId: generateCheckpointId(),
				latestCheckpointAt: 0,
			},
			checkpointStore: new InMemoryCheckpointStore(),
		})
		expect(resumeCalls).toHaveLength(1)
		const resumed = resumeCalls[0]
		expect(resumed && providerConfigurations.get(resumed.provider)).toMatchObject({
			type: 'zen-go',
			sessionId: originalSessionId,
		})
		const fallback = resumed?.fallbackProviders?.[0]
		expect(fallback && providerConfigurations.get(fallback.provider)).toMatchObject({
			type: 'zen',
			sessionId: originalSessionId,
		})
	} finally {
		await session.close()
	}
})
