import { asSessionId } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import type { AgentSessionOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

it('keeps provider selection session-local, preserves delegation/fallback preferences and refuses changes with active jobs', async () => {
	const sessionId = asSessionId(fixtureUuid('desktop-model-owner'))
	let jobs: { status: string }[] = []
	const close = vi.fn(async () => {})
	const createSession = vi.fn(
		async (_preferences: unknown, _detected: unknown, _options: AgentSessionOptions) => ({
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			close,
			jobs: () => jobs,
			send: async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as const
			},
		}),
	)
	const preferences = {
		version: 3,
		providers: [
			{ id: 'zen', model: 'old', credential: 'SYNTHETIC_SECRET_MUST_NOT_REACH_UI' },
			{ id: 'openai', model: 'fallback' },
		],
		allowCapabilityMismatch: true,
		subagents: { active: ['worker'] },
	}
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences,
				detected: [{ entry: { id: 'zen', label: 'Zen', defaultModel: 'free' } }],
				needsRepickReason: null,
			}),
			createSession,
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async () => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	try {
		await runtime.selectProvider(sessionId, 'zen', 'selected')
		expect(await runtime.providerStatus(sessionId)).toMatchObject({
			selected: { id: 'zen', model: 'selected' },
		})
		expect(JSON.stringify(await runtime.providerStatus())).not.toContain(
			'SYNTHETIC_SECRET_MUST_NOT_REACH_UI',
		)
		expect(await runtime.providerStatus()).toMatchObject({
			selected: { id: 'zen', model: 'old' },
		})
		await runtime.gateway.prompt({
			sessionId,
			cwd: '/project',
			prompt: 'test',
			history: [],
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
		})
		expect(createSession.mock.calls[0]?.[0]).toEqual({
			...preferences,
			providers: [
				{ id: 'zen', model: 'selected' },
				{ id: 'openai', model: 'fallback' },
			],
		})
		jobs = [{ status: 'running' }]
		await runtime.selectProvider(sessionId, 'zen', 'selected')
		expect(close).not.toHaveBeenCalled()
		await expect(runtime.selectProvider(sessionId, 'zen', 'changed')).rejects.toThrow('active work')
		expect(await runtime.providerStatus(sessionId)).toMatchObject({
			selected: { model: 'selected' },
		})
		jobs = []
		await runtime.selectProvider(sessionId, 'zen', 'changed')
		expect(close).toHaveBeenCalledOnce()
	} finally {
		await runtime.close()
	}
})
