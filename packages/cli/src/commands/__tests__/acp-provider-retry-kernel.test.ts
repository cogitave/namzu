import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, asSessionId } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import {
	closeSessions,
	openSessions,
	readConversationFacts,
} from '../../integrations/sessions/store.js'
import { createAgentSession } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { providerPaused } from './support/provider-paused.js'

it('resumes a measured durable provider pause through the actual SDK kernel with no new prompt', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-acp-real-resume-'))
	const home = join(root, 'state')
	await mkdir(home)
	vi.stubEnv('NAMZU_HOME', home)
	const state = await openSessions(root)
	const f = await providerPaused(state)
	const provider = new MockLLMProvider({ responseText: 'The original robot task resumed.' })
	const construct = vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'zen', model: 'original-model' }],
					subagents: { active: [] },
				},
				detected: [
					{
						entry: PROVIDER_REGISTRY.zen,
						apiKey: 'synthetic-provider-key',
						source: { kind: 'env', envName: 'SYNTHETIC_PROVIDER_KEY' },
						alternatives: [],
					},
				],
				needsRepickReason: null,
			}),
			createSession: createAgentSession,
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async (sessionId: string) => ({ sessionId: asSessionId(sessionId) }),
			openSessions,
		} as unknown as AcpRuntimeDependencies,
	)
	try {
		const result = await runtime.gateway.retry!({
			sessionId: f.sessionId,
			turnId: f.turnId,
			checkpointId: f.checkpointId,
			options: { permissionMode: 'plan' },
			cwd: root,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
			history: [],
			filesystem: undefined,
		})
		expect(result.stopReason).toBe('end_turn')
		expect(result.history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: 'assistant', content: 'The original robot task resumed.' }),
			]),
		)
		expect(provider.requests.length).toBeGreaterThan(0)
		expect(provider.requests.every((request) => request.model === 'original-model')).toBe(true)
		const facts = await readConversationFacts(state, f.sessionId)
		expect(facts?.activeTurn).toBeUndefined()
		expect(facts?.records.filter((row) => row.type === 'turn_started')).toHaveLength(1)
		expect(
			facts?.records.filter((row) => row.type === 'message' && row.role === 'user'),
		).toHaveLength(1)
		expect(facts?.records.find((row) => row.type === 'turn_resuming')).toMatchObject({
			turnId: f.turnId,
			fromCheckpointId: f.checkpointId,
		})
	} finally {
		await runtime.close()
		construct.mockRestore()
		closeSessions(state)
		vi.unstubAllEnvs()
		removeTempDir(root)
	}
})
