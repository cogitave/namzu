import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	MockLLMProvider,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { openCliAccounts } from '../../integrations/accounts/open.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { ensureRegistered } from '../../integrations/providers/register.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-account-bind-'))
	roots.push(root)
	const cwd = join(root, 'checkout')
	const home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	return { cwd, home }
}

const usual: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'session' },
		apiKey: 'usual-key',
		alternatives: [],
	},
]

async function captureProviders() {
	await ensureRegistered('openai')
	const configs: Record<string, unknown>[] = []
	const requests: ChatCompletionParams[] = []
	vi.spyOn(ProviderRegistry, 'createProvider').mockImplementation((config) => {
		configs.push(config as unknown as Record<string, unknown>)
		return new MockLLMProvider({
			responseText: 'done',
			onRequest: (params) =>
				requests.push({ ...params, messages: structuredClone(params.messages) }),
		})
	})
	return { configs, requests }
}

async function drain(session: { send: (m: never) => AsyncIterable<unknown> }, text: string) {
	for await (const _ of session.send([createUserMessage(text)] as never)) {
		/* drain */
	}
}

it('builds the provider from the account chosen, and names it, while the usual sign-in is untouched', async () => {
	const { cwd, home } = workspace()
	const accounts = openCliAccounts({ home })
	accounts.registry.add({
		provider: 'openai',
		label: 'free-a',
		kind: 'api-key',
		apiKey: 'free-a-key',
		baseUrl: 'https://api.example.test/v1',
		defaultModel: 'glm-fixture',
	})
	const { configs } = await captureProviders()
	const { createAgentSession } = await import('../agent.js')
	const prefs: Preferences = {
		version: 3,
		providers: [{ id: 'openai', model: 'glm-fixture', account: 'openai:free-a' }],
		subagents: { active: [] },
	}
	const bound = await createAgentSession(prefs, usual, {
		cwd,
		ephemeral: true,
		accounts,
		sandbox: { enabled: false },
		limits: { maxIterations: 2 },
	})
	const plain = await createAgentSession(
		{ ...prefs, providers: [{ id: 'openai', model: 'glm-fixture' }] },
		usual,
		{ cwd, ephemeral: true, accounts, sandbox: { enabled: false }, limits: { maxIterations: 2 } },
	)
	try {
		expect(bound.hasProvider, bound.errorHint ?? undefined).toBe(true)
		expect(bound.account).toEqual({ id: 'openai:free-a', label: 'free-a', provider: 'openai' })
		const boundConfig = configs.find((config) => config.apiKey === 'free-a-key')
		expect(boundConfig).toMatchObject({ baseURL: 'https://api.example.test/v1' })
		// A conversation on the usual sign-in names the account its provider has
		// others of, so a switch back is visible.
		expect(plain.account).toEqual({ id: 'openai:default', label: 'default', provider: 'openai' })
		expect(configs.some((config) => config.apiKey === 'usual-key')).toBe(true)
		expect(JSON.stringify(configs.filter((c) => c.apiKey === 'usual-key'))).not.toContain(
			'api.example.test',
		)
	} finally {
		await bound.close()
		await plain.close()
	}
})

it('refuses an account whose credential is gone, before a session exists, in plain words', async () => {
	const { cwd, home } = workspace()
	const accounts = openCliAccounts({ home })
	const { createAgentSession } = await import('../agent.js')
	await captureProviders()
	const missing = await createAgentSession(
		{
			version: 3,
			providers: [{ id: 'openai', account: 'openai:gone' }],
			subagents: { active: [] },
		},
		usual,
		{ cwd, ephemeral: true, accounts, sandbox: { enabled: false } },
	)
	expect(missing.hasProvider).toBe(false)
	expect(missing.errorHint).toBe('That account is no longer set up. Choose another with /auth.')
	for (const hidden of ['openai:gone', 'keyRef']) expect(missing.errorHint).not.toContain(hidden)
})

it('records the binding in the conversation once, however often the session is rebuilt', async () => {
	const { cwd, home } = workspace()
	const accounts = openCliAccounts({ home })
	const { openSessions, recordAccountBound, readConversationFacts } = await import(
		'../../integrations/sessions/store.js'
	)
	const sessions = await openSessions(cwd)
	try {
		const { startConversation } = await import('../../integrations/sessions/store.js')
		const sessionId = await startConversation(sessions)
		expect(
			await recordAccountBound(sessions, sessionId, {
				accountId: 'openai:work',
				provider: 'openai',
				reason: 'user_switch',
			}),
		).toBe(true)
		// The log already ends in this binding: nothing more is written.
		expect(
			await recordAccountBound(sessions, sessionId, {
				accountId: 'openai:work',
				provider: 'openai',
				reason: 'start',
			}),
		).toBe(false)
		const facts = await readConversationFacts(sessions, sessionId, 'strict')
		expect(
			facts?.records.filter((record) => record.type === 'account_bound').map((r) => r.accountId),
		).toEqual(['openai:work'])
	} finally {
		const { closeSessions } = await import('../../integrations/sessions/store.js')
		closeSessions(sessions)
	}
})

it('records a switch back to the usual sign-in, so a resume does not return to the account left', async () => {
	const { cwd, home } = workspace()
	const accounts = openCliAccounts({ home })
	accounts.registry.add({
		provider: 'openai',
		label: 'work',
		kind: 'api-key',
		apiKey: 'work-key',
	})
	const { resolveBoundAccount } = await import('@namzu/sdk')
	const {
		openSessions,
		closeSessions,
		startConversation,
		recordAccountBound,
		readConversationFacts,
	} = await import('../../integrations/sessions/store.js')
	const sessions = await openSessions(cwd)
	try {
		const sessionId = await startConversation(sessions)
		// Never left the usual sign-in: nothing is written.
		expect(
			await recordAccountBound(sessions, sessionId, {
				accountId: 'openai:default',
				provider: 'openai',
				reason: 'user_switch',
			}),
		).toBe(false)
		await recordAccountBound(sessions, sessionId, {
			accountId: 'openai:work',
			provider: 'openai',
			reason: 'user_switch',
		})
		expect(
			await recordAccountBound(sessions, sessionId, {
				accountId: 'openai:default',
				provider: 'openai',
				reason: 'user_switch',
			}),
		).toBe(true)
		const facts = await readConversationFacts(sessions, sessionId, 'strict')
		expect(resolveBoundAccount(facts?.records ?? [], 'openai', accounts.registry).accountId).toBe(
			'openai:default',
		)
	} finally {
		closeSessions(sessions)
	}
})
