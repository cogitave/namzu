import { asSessionId } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import type { ModelListing } from '../../tui/agent.js'
import { createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

const context = {
	config: {},
	formatter: { name: 'text' as const, print: () => {}, info: () => {}, error: () => {} },
}

function runtimeFor(
	detected: readonly DetectedProvider[],
	describeModels: (
		id: string,
		detected: DetectedProvider,
		signal?: AbortSignal,
	) => Promise<ModelListing>,
	preferences: Preferences | null = null,
) {
	const createSession = vi.fn()
	const runtime = createCliAcpRuntime(context, {
		probe: async () => ({ preferences, detected, needsRepickReason: null, credentialGap: null }),
		describeModels,
		createSession,
		decideTrust: () => ({ allowed: true, cwd: '/project' }),
		resolveProjectContext: (ctx) => ctx,
		resolveSession: async () => ({ sessionId: asSessionId(fixtureUuid('model-catalogue')) }),
	})
	return { runtime, createSession }
}

it('projects real configured model rows without credential envelopes or a model session', async () => {
	const detected: DetectedProvider = {
		entry: PROVIDER_REGISTRY['anthropic'],
		apiKey: 'SYNTHETIC_SECRET_MUST_NOT_REACH_UI',
		source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
		alternatives: [],
	}
	const describe = vi.fn(
		async (): Promise<ModelListing> => ({
			kind: 'ok',
			models: [
				{ id: 'listed-model', name: 'Listed model', inputModalities: ['text', 'image'] },
				{ id: 'listed-model', name: 'Duplicate row' },
			],
		}),
	)
	const { runtime, createSession } = runtimeFor([detected], describe, {
		version: 3,
		providers: [{ id: 'anthropic', model: 'custom-pinned' }],
		subagents: { active: [] },
	})
	try {
		const result = await runtime.models('anthropic')
		expect(result).toEqual({
			models: [
				{
					id: detected.entry.defaultModel,
					label: detected.entry.defaultModel,
					note: '(namzu default)',
				},
				{ id: 'listed-model', label: 'Listed model', note: '(image input)' },
				{ id: 'custom-pinned', label: 'custom-pinned', note: '(current)' },
			],
			notice: null,
		})
		expect(describe).toHaveBeenCalledWith('anthropic', detected, expect.any(AbortSignal))
		expect(JSON.stringify(result)).not.toContain(detected.apiKey)
		expect(createSession).not.toHaveBeenCalled()
		await expect(runtime.models('unconfigured')).rejects.toThrow('not configured')
		expect(describe).toHaveBeenCalledOnce()
	} finally {
		await runtime.close()
	}
})

it('filters credential-required Zen models and an inaccessible saved pin from anonymous choices', async () => {
	const { runtime } = runtimeFor(
		[{ entry: PROVIDER_REGISTRY.zen, source: { kind: 'public' }, alternatives: [] }],
		async () => ({
			kind: 'ok',
			models: [
				{ id: 'space-bunny-free', name: 'Space Bunny Free', inputPrice: 0, outputPrice: 0 },
				{ id: 'paid-model', name: 'Paid model', inputPrice: 1, outputPrice: 2 },
			],
		}),
		{ version: 3, providers: [{ id: 'zen', model: 'paid-model' }], subagents: { active: [] } },
	)
	try {
		expect(await runtime.models('zen')).toEqual({
			models: [{ id: 'space-bunny-free', label: 'Space Bunny Free', note: '(namzu default)' }],
			notice: null,
		})
	} finally {
		await runtime.close()
	}
})

it('exposes the bounded desktop wire method and validates provider and session parameters', async () => {
	const describe = vi.fn(async (): Promise<ModelListing> => ({ kind: 'unsupported' }))
	const { runtime } = runtimeFor(
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'synthetic',
				source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
				alternatives: [],
			},
		],
		describe,
	)
	try {
		const host = createDesktopHostExtensions(runtime, process.cwd())
		expect(await host['namzu/providers/models']({ provider: 'openai' })).toMatchObject({
			models: [{ id: 'gpt-4o', label: 'gpt-4o' }],
			notice: expect.any(String),
		})
		expect(() => host['namzu/providers/models']({ provider: '' })).toThrow('Invalid provider')
		expect(() =>
			host['namzu/providers/models']({ provider: 'openai', sessionId: 'foreign' }),
		).toThrow('Invalid conversation id')
		expect(describe).toHaveBeenCalledOnce()
	} finally {
		await runtime.close()
	}
})

it('keeps a known choice with an honest fallback notice and excludes raw driver diagnostics', async () => {
	const { runtime } = runtimeFor(
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'synthetic',
				source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
				alternatives: [],
			},
		],
		async () => ({ kind: 'failed', reason: 'remote error: SYNTHETIC_SECRET_MUST_NOT_REACH_UI' }),
	)
	try {
		const result = await runtime.models('openai')
		expect(result.models).toEqual([{ id: 'gpt-4o', label: 'gpt-4o', note: '(namzu default)' }])
		expect(result.notice).toContain('could not be loaded')
		expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_MUST_NOT_REACH_UI')
	} finally {
		await runtime.close()
	}
})

it('shares an in-flight catalogue and reads it freshly on the next open without changing selected models', async () => {
	let resolve!: (value: ModelListing) => void
	const pending = new Promise<ModelListing>((done) => {
		resolve = done
	})
	const describe = vi.fn(() => pending)
	const { runtime, createSession } = runtimeFor(
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'synthetic',
				source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
				alternatives: [],
			},
		],
		describe,
	)
	try {
		const sessionId = asSessionId(fixtureUuid('session-specific-catalogue'))
		await runtime.selectProvider(sessionId, 'openai', 'current-for-this-session')
		const first = runtime.models('openai', sessionId)
		const second = runtime.models('openai')
		resolve({ kind: 'unsupported' })
		const [selected, general] = await Promise.all([first, second])
		expect(describe).toHaveBeenCalledOnce()
		expect(selected.models.at(-1)?.id).toBe('current-for-this-session')
		expect(general.models).toHaveLength(1)
		await runtime.models('openai')
		expect(describe).toHaveBeenCalledTimes(2)
		expect(await runtime.providerStatus(sessionId)).toMatchObject({
			selected: { id: 'openai', model: 'current-for-this-session' },
		})
		expect(createSession).not.toHaveBeenCalled()
	} finally {
		await runtime.close()
	}
})

it('bounds a large catalogue and reports the omitted rows instead of implying a complete list', async () => {
	const { runtime } = runtimeFor(
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'synthetic',
				source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
				alternatives: [],
			},
		],
		async () => ({
			kind: 'ok',
			models: Array.from({ length: 4_100 }, (_, index) => ({
				id: `model-${index}`,
				name: 'x'.repeat(500),
			})),
		}),
	)
	try {
		const result = await runtime.models('openai')
		expect(result.models).toHaveLength(4_096)
		expect(result.models[0]?.id).toBe('gpt-4o')
		expect(result.models[1]?.label).toHaveLength(400)
		expect(result.notice).toContain('first 4,096')
	} finally {
		await runtime.close()
	}
})

it('aborts an owned catalogue when the connection closes and refuses its late result', async () => {
	let began!: () => void
	const started = new Promise<void>((resolve) => {
		began = resolve
	})
	let finish!: (value: ModelListing) => void
	const listing = new Promise<ModelListing>((resolve) => {
		finish = resolve
	})
	let signal: AbortSignal | undefined
	const { runtime } = runtimeFor(
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'synthetic',
				source: { kind: 'env', envName: 'SYNTHETIC_KEY' },
				alternatives: [],
			},
		],
		async (_id, _detected, ownedSignal) => {
			signal = ownedSignal
			began()
			return listing
		},
	)
	const operation = runtime.models('openai')
	const rejected = expect(operation).rejects.toThrow('connection is closed')
	await started
	await runtime.close()
	finish({ kind: 'unsupported' })
	await rejected
	expect(signal?.aborted).toBe(true)
	await expect(runtime.models('openai')).rejects.toThrow('connection is closed')
})
