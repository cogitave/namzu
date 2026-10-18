import { asSessionId } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import type { RoutingConfig } from '../../config/schema.js'
import type { AgentSessionOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

const routing: RoutingConfig = { default: { provider: 'zen', model: 'free' } }
const formatter = { name: 'text', print: () => {}, info: () => {}, error: () => {} }

function build(options: {
	config: Record<string, unknown>
	pal?: boolean
	jobs?: () => { status: string }[]
}) {
	const sessionId = asSessionId(fixtureUuid('desktop-auto-owner'))
	const close = vi.fn(async () => {})
	const createSession = vi.fn(
		async (_preferences: unknown, _detected: unknown, _options: AgentSessionOptions) => ({
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			close,
			jobs: options.jobs ?? (() => []),
			send: async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as const
			},
		}),
	)
	const runtime = createCliAcpRuntime(
		{ config: options.config, formatter } as never,
		{
			probe: async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'zen', model: 'old' }],
					subagents: { active: [] },
				},
				detected: [
					{ entry: { id: 'zen', label: 'Zen', defaultModel: 'free' }, apiKey: 'synthetic' },
				],
				needsRepickReason: null,
			}),
			createSession,
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async () => ({ sessionId }),
			...(options.pal ? { palBinding: async () => ({ definition: {}, pal: {} }) } : {}),
		} as unknown as AcpRuntimeDependencies,
	)
	const prompt = () =>
		runtime.gateway.prompt({
			sessionId,
			cwd: '/project',
			prompt: 'test',
			history: [],
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
		})
	return { runtime, sessionId, createSession, close, prompt }
}

const routingOf = (call: unknown[] | undefined) => (call?.[2] as AgentSessionOptions).routing

it('offers no Auto when there is no routing block, and refuses it in plain words', async () => {
	const { runtime, sessionId, createSession, prompt } = build({ config: { model: 'auto' } })
	try {
		expect(await runtime.providerStatus(sessionId)).not.toHaveProperty('auto')
		await expect(runtime.selectAuto?.(sessionId)).rejects.toThrow('routing block')
		await prompt()
		expect(routingOf(createSession.mock.calls[0])).toBeUndefined()
	} finally {
		await runtime.close()
	}
})

it('offers Auto as available but not active when only routing is configured', async () => {
	const { runtime, sessionId, createSession, close, prompt } = build({ config: { routing } })
	try {
		expect(await runtime.providerStatus(sessionId)).toMatchObject({ auto: { active: false } })
		await prompt()
		expect(routingOf(createSession.mock.calls[0])).toBeUndefined()

		await runtime.selectAuto?.(sessionId)
		expect(close).toHaveBeenCalledOnce()
		expect(await runtime.providerStatus(sessionId)).toMatchObject({ auto: { active: true } })
		await prompt()
		expect(routingOf(createSession.mock.calls[1])).toEqual(routing)

		// Choosing Auto twice rebuilds nothing.
		await runtime.selectAuto?.(sessionId)
		expect(close).toHaveBeenCalledOnce()
	} finally {
		await runtime.close()
	}
})

it('starts on Auto under model: auto and a hand-picked model turns it off, even the running one', async () => {
	const { runtime, sessionId, createSession, close, prompt } = build({
		config: { model: 'auto', routing },
	})
	try {
		expect(await runtime.providerStatus(sessionId)).toMatchObject({ auto: { active: true } })
		await prompt()
		expect(routingOf(createSession.mock.calls[0])).toEqual(routing)

		// The model that happens to be running is a hand pick too: Auto ends and the session rebuilds.
		await runtime.selectProvider(sessionId, 'zen', 'old')
		expect(close).toHaveBeenCalledOnce()
		expect(await runtime.providerStatus(sessionId)).toMatchObject({
			auto: { active: false },
			selected: { id: 'zen', model: 'old' },
		})
		await prompt()
		expect(routingOf(createSession.mock.calls[1])).toBeUndefined()

		await runtime.selectAuto?.(sessionId)
		await prompt()
		expect(routingOf(createSession.mock.calls[2])).toEqual(routing)
	} finally {
		await runtime.close()
	}
})

it('refuses to change to Auto while the conversation has active work', async () => {
	let jobs: { status: string }[] = []
	const { runtime, sessionId, close, prompt } = build({
		config: { routing },
		jobs: () => jobs,
	})
	try {
		await prompt()
		jobs = [{ status: 'running' }]
		await expect(runtime.selectAuto?.(sessionId)).rejects.toThrow('active work')
		expect(close).not.toHaveBeenCalled()
		expect(await runtime.providerStatus(sessionId)).toMatchObject({ auto: { active: false } })
	} finally {
		await runtime.close()
	}
})

it('never offers Auto in a Pal conversation', async () => {
	const { runtime, sessionId } = build({ config: { model: 'auto', routing }, pal: true })
	try {
		expect(await runtime.providerStatus(sessionId)).not.toHaveProperty('auto')
		await expect(runtime.selectAuto?.(sessionId)).rejects.toThrow('Pal')
	} finally {
		await runtime.close()
	}
})
