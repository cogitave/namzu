/** A borrowed Codex device session reaches every real AgentSession operation. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ProviderRegistry, createUserMessage } from '@namzu/sdk'

import { PROVIDER_REGISTRY, type Preferences } from '../../integrations/providers/index.js'
import { type AgentSession, createAgentSession } from '../agent.js'

const runCalls = vi.hoisted(() => ({
	queries: [] as Record<string, unknown>[],
	resumes: [] as Record<string, unknown>[],
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			runCalls.queries.push(params)
			return (async function* () {})()
		},
		resumeRun: async (params: Record<string, unknown>) => {
			runCalls.resumes.push(params)
			return { resumed: false, reason: 'no-checkpoint' } as const
		},
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => {
		throw new Error('subagent intentionally unavailable in codex credential fixture')
	},
}))

const preferences = {
	version: 3,
	providers: [{ id: 'codex' }],
	subagents: { active: [] },
} as Preferences

const roots: string[] = []
const sessions: AgentSession[] = []
const constructions: Array<{ token: string; accountId: string; model: string }> = []

function jwt(exp: number): string {
	return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`
}

function writeCodex(path: string, token: string, accountId: string, exp: number): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(
		path,
		JSON.stringify({
			tokens: { access_token: token || jwt(exp), account_id: accountId },
		}),
		{ mode: 0o600 },
	)
}

function providerToken(params: Record<string, unknown>): string | undefined {
	return (params.provider as { token?: string } | undefined)?.token
}

beforeEach(() => {
	runCalls.queries.length = 0
	runCalls.resumes.length = 0
	constructions.length = 0
	vi.spyOn(ProviderRegistry, 'create').mockImplementation(((config: Record<string, unknown>) => {
		const token = String(config.accessToken ?? '')
		const accountId = String(config.accountId ?? '')
		const model = String(config.model ?? '')
		constructions.push({ token, accountId, model })
		return {
			provider: {
				id: 'codex-recording-provider',
				token,
				accountId,
				reasoningEffortLevelsFor: () => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
				reasoningEffortDefaultFor: () => 'low' as const,
			},
		}
	}) as never)
})

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
	vi.restoreAllMocks()
})

it('offers the admitted account, adopts rotations, and refuses deletion before model work', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-codex-session-'))
	roots.push(root)
	const authPath = join(root, 'codex', 'auth.json')
	const firstToken = jwt(Math.floor(Date.now() / 1000) + 3600)
	writeCodex(authPath, firstToken, 'account-a', 0)

	const detected = [
		{
			entry: PROVIDER_REGISTRY.codex,
			source: { kind: 'codex-file' as const, path: authPath },
			apiKey: firstToken,
			codex: {
				accountId: 'account-a',
				expiresAt: Date.now() + 3_600_000,
				origin: 'codex-file' as const,
			},
			alternatives: [],
		},
	]
	const session = await createAgentSession(preferences, detected, {
		cwd: root,
	})
	sessions.push(session)
	expect(session.hasProvider).toBe(true)
	expect(session.reasoningEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
	expect(session.reasoningEffortDefault).toBe('low')
	expect(constructions).toEqual([
		{
			token: firstToken,
			accountId: 'account-a',
			model: PROVIDER_REGISTRY.codex.defaultModel,
		},
	])

	const secondToken = jwt(Math.floor(Date.now() / 1000) + 7200)
	writeCodex(authPath, secondToken, 'account-b', 0)
	await session
		.send([createUserMessage('use the rotated session')])
		[Symbol.asyncIterator]()
		.next()
	expect(constructions.at(-1)).toEqual({
		token: secondToken,
		accountId: 'account-b',
		model: PROVIDER_REGISTRY.codex.defaultModel,
	})
	expect(runCalls.queries.map(providerToken)).toEqual([secondToken])
	expect(runCalls.queries[0]?.runConfig).toMatchObject({
		model: PROVIDER_REGISTRY.codex.defaultModel,
	})

	rmSync(authPath)
	const before = runCalls.queries.length
	await expect(
		session
			.send([createUserMessage('must not use a withdrawn token')])
			[Symbol.asyncIterator]()
			.next(),
	).rejects.toThrow(/Codex session Namzu borrowed is no longer available/)
	expect(runCalls.queries).toHaveLength(before)
})

it('never publishes a provider default outside its exact effort menu', async () => {
	vi.mocked(ProviderRegistry.create).mockImplementation(((config: Record<string, unknown>) => ({
		provider: {
			id: 'inconsistent-effort-provider',
			token: String(config.accessToken ?? ''),
			reasoningEffortLevelsFor: () => ['low', 'medium'] as const,
			reasoningEffortDefaultFor: () => 'high' as const,
		},
	})) as never)

	const root = mkdtempSync(join(tmpdir(), 'namzu-codex-effort-default-'))
	roots.push(root)
	const authPath = join(root, 'codex', 'auth.json')
	const token = jwt(Math.floor(Date.now() / 1000) + 3600)
	writeCodex(authPath, token, 'account-a', 0)

	const session = await createAgentSession(
		preferences,
		[
			{
				entry: PROVIDER_REGISTRY.codex,
				source: { kind: 'codex-file' as const, path: authPath },
				apiKey: token,
				codex: {
					accountId: 'account-a',
					expiresAt: Date.now() + 3_600_000,
					origin: 'codex-file' as const,
				},
				alternatives: [],
			},
		],
		{ cwd: root },
	)
	sessions.push(session)

	expect(session.reasoningEffortLevels).toEqual(['low', 'medium'])
	expect(session.reasoningEffortDefault).toBeUndefined()
	expect(session.configNotices).toEqual(
		expect.arrayContaining([expect.stringMatching(/default.*outside its exact menu/i)]),
	)
})
