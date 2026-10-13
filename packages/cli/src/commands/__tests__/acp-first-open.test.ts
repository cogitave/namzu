import { asSessionId } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

const found = (
	id: keyof typeof PROVIDER_REGISTRY,
	source: DetectedProvider['source'],
	apiKey?: string,
): DetectedProvider => ({
	entry: PROVIDER_REGISTRY[id],
	source,
	...(apiKey ? { apiKey } : {}),
	alternatives: [],
})

function runtimeWith(detected: DetectedProvider[], preferences: Preferences | null) {
	return createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({ preferences, detected, needsRepickReason: null, credentialGap: null }),
			createSession: async () => {
				throw new Error('no session is built in this test')
			},
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async () => ({ sessionId: asSessionId(fixtureUuid('first-open')) }),
		} as unknown as AcpRuntimeDependencies,
	)
}

it('offers the free Zen models as the automatic pick when nothing else is found', async () => {
	const runtime = runtimeWith([found('zen', { kind: 'public' })], null)
	try {
		expect(await runtime.providerStatus()).toEqual({
			available: [
				{
					id: 'zen',
					label: 'Zen',
					defaultModel: 'space-bunny-free',
					anonymous: true,
					via: 'free',
				},
			],
			selected: { id: 'zen', automatic: true },
		})
	} finally {
		await runtime.close()
	}
})

it('picks a detected sign-in before a local server and the free models', async () => {
	const runtime = runtimeWith(
		[
			found('anthropic', { kind: 'claude-file', path: '/synthetic' }, 'synthetic-token'),
			found('ollama', { kind: 'probe', url: 'http://localhost:11434/api/tags' }),
			found('zen', { kind: 'public' }),
		],
		null,
	)
	try {
		const status = (await runtime.providerStatus()) as {
			available: { id: string; via?: string }[]
			selected: { id: string; automatic?: true }
		}
		expect(status.available.map(({ id, via }) => [id, via])).toEqual([
			['anthropic', 'sign-in'],
			['ollama', 'local'],
			['zen', 'free'],
		])
		expect(status.selected).toEqual({ id: 'anthropic', automatic: true })
		expect(JSON.stringify(status)).not.toContain('synthetic-token')
	} finally {
		await runtime.close()
	}
})

it('does not call a saved choice automatic', async () => {
	const saved: Preferences = {
		version: 3,
		providers: [{ id: 'zen', model: 'space-bunny-free' }],
		subagents: { active: [] },
	}
	const runtime = runtimeWith([found('zen', { kind: 'public' })], saved)
	try {
		const status = (await runtime.providerStatus()) as { selected: Record<string, unknown> }
		expect(status.selected).toEqual({ id: 'zen', model: 'space-bunny-free' })
	} finally {
		await runtime.close()
	}
})
