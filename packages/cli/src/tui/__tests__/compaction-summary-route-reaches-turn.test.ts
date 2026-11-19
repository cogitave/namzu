/**
 * `compaction.modelSummary` and the small model reach the automatic summary only if the turn the
 * session starts hands a route to the kernel. The route was once built and then dropped on the way
 * to `query`, so the setting did nothing. The session is real and the kernel's `query` is the
 * witness: what it receives is what the kernel would use to ask the small model.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MockLLMProvider,
	ProviderRegistry,
	type QueryParams,
	createUserMessage,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'

const queryCalls: QueryParams[] = []

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: QueryParams) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

vi.mock('../../integrations/providers/register.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/register.js')>()
	return {
		...actual,
		ensureRegistered: async () => {},
		isRegistered: () => true,
		resolveChainCapabilities: async () => [],
	}
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'gpt-5.5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

let cwd: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-summary-route-'))
	queryCalls.length = 0
	vi.spyOn(ProviderRegistry, 'create').mockImplementation(
		() => ({ provider: new MockLLMProvider(), capabilities: {} }) as never,
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
})

async function paramsOfOneTurn(compaction?: { modelSummary?: boolean }): Promise<QueryParams> {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, {
		cwd,
		scope: {
			sessionId: generateSessionId(),
			projectId: generateProjectId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		},
		...(compaction ? { compaction } : {}),
	})
	try {
		expect(session.hasProvider, session.errorHint ?? '').toBe(true)
		for await (const event of session.send([createUserMessage('hello')])) {
			if (event.kind === 'error') throw new Error(event.message)
		}
	} finally {
		await session.close()
	}
	expect(queryCalls).toHaveLength(1)
	return queryCalls[0] as QueryParams
}

describe('the compaction summary route reaches the kernel from a turn', () => {
	it('is handed to the kernel by default', async () => {
		const params = await paramsOfOneTurn()
		expect(typeof params.compactionSummaryRoute).toBe('function')
	})

	it('is handed to the kernel while modelSummary is on', async () => {
		const params = await paramsOfOneTurn({ modelSummary: true })
		expect(typeof params.compactionSummaryRoute).toBe('function')
	})

	it('is not handed to the kernel when modelSummary is off', async () => {
		const params = await paramsOfOneTurn({ modelSummary: false })
		expect(params.compactionSummaryRoute).toBeUndefined()
	})
})
