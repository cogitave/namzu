/** OAuth refresh cancellation and serialization at the real AgentSession boundary. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderRegistry, createUserMessage } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	CredentialPublicationError,
	CredentialRefreshRejectedError,
	CredentialWithdrawnError,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentSession, createAgentSession } from '../agent.js'

const stored = vi.hoisted(() => ({
	current: null as null | {
		accessToken: string
		refreshToken?: string
		expiresAt?: number
		scopes?: readonly string[]
	},
}))
const borrowedExternal = vi.hoisted(() => ({
	current: null as null | {
		accessToken: string
		refreshToken?: string
		expiresAt?: number
		scopes?: readonly string[]
	},
}))
const replaceBorrowed = vi.hoisted(() =>
	vi.fn(
		(
			_path: string,
			expected: { accessToken: string; refreshToken?: string; expiresAt?: number },
			replacement: { accessToken: string; refreshToken?: string; expiresAt?: number },
		) => {
			const current = borrowedExternal.current
			if (
				!current ||
				current.accessToken !== expected.accessToken ||
				current.refreshToken !== expected.refreshToken ||
				current.expiresAt !== expected.expiresAt
			) {
				return { replaced: false, current }
			}
			borrowedExternal.current = replacement
			return { replaced: true, current: replacement }
		},
	),
)
const readStored = vi.hoisted(() => vi.fn(() => stored.current))
const writeStored = vi.hoisted(() =>
	vi.fn(
		(credential: {
			accessToken: string
			refreshToken?: string
			expiresAt?: number
			scopes?: readonly string[]
		}) => {
			stored.current = credential
			return '/tmp/namzu-token-refresh-test/credentials.json'
		},
	),
)
const replaceStored = vi.hoisted(() =>
	vi.fn(
		(
			expected: {
				accessToken: string
				refreshToken?: string
				expiresAt?: number
				scopes?: readonly string[]
			},
			replacement: {
				accessToken: string
				refreshToken?: string
				expiresAt?: number
				scopes?: readonly string[]
			},
		) => {
			const current = stored.current
			if (
				!current ||
				current.accessToken !== expected.accessToken ||
				current.refreshToken !== expected.refreshToken ||
				current.expiresAt !== expected.expiresAt ||
				JSON.stringify(current.scopes ?? []) !== JSON.stringify(expected.scopes ?? [])
			) {
				return { replaced: false, current }
			}
			writeStored(replacement)
			return { replaced: true, current: replacement }
		},
	),
)

vi.mock('../../integrations/providers/credential-store.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../integrations/providers/credential-store.js')>()
	return {
		...actual,
		readStoredSubscriptionCredential: readStored,
		writeStoredSubscriptionCredential: writeStored,
		replaceStoredSubscriptionCredential: replaceStored,
	}
})

vi.mock('../../integrations/providers/harness-credentials.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../integrations/providers/harness-credentials.js')>()
	return {
		...actual,
		readClaudeCredentialFile: () => borrowedExternal.current,
		replaceClaudeCredentialFile: replaceBorrowed,
	}
})

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
		throw new Error('subagent intentionally unavailable in token refresh fixture')
	},
}))

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const roots: string[] = []
const sessions: AgentSession[] = []
const constructedTokens: string[] = []

function detectedSubscription() {
	return [
		{
			entry: PROVIDER_REGISTRY['anthropic'],
			source: { kind: 'stored', path: '/tmp/credentials.json' },
			apiKey: 'cc-old',
			oauth: {
				refreshToken: 'rt-old',
				expiresAt: 0,
				origin: 'stored' as const,
			},
			alternatives: [],
		},
	]
}

function detectedBorrowedSubscription() {
	return [
		{
			entry: PROVIDER_REGISTRY['anthropic'],
			source: { kind: 'claude-file', path: '/tmp/.claude/.credentials.json' },
			apiKey: 'cc-borrowed',
			oauth: {
				refreshToken: 'rt-borrowed',
				expiresAt: Date.now() + 3_600_000,
				origin: 'claude-file' as const,
				sourcePath: '/tmp/.claude/.credentials.json',
			},
			alternatives: [],
		},
	]
}

function providerToken(params: Record<string, unknown>): string | undefined {
	return (params.provider as { token?: string } | undefined)?.token
}

function durableEntry(suffix: string) {
	return {
		runId: `run_refresh_${suffix}`,
		tenantId: 'ten_refresh',
		projectId: 'prj_refresh',
		sessionId: 'ses_refresh',
	} as never
}

async function within<T>(operation: Promise<T>, ms = 250): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function session(): Promise<AgentSession> {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-refresh-session-'))
	roots.push(cwd)
	const result = await createAgentSession(preferences, detectedSubscription() as never, { cwd })
	sessions.push(result)
	return result
}

async function borrowedSession(): Promise<AgentSession> {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-borrowed-claude-session-'))
	roots.push(cwd)
	const result = await createAgentSession(preferences, detectedBorrowedSubscription() as never, {
		cwd,
	})
	sessions.push(result)
	return result
}

beforeEach(() => {
	stored.current = {
		accessToken: 'cc-old',
		refreshToken: 'rt-old',
		expiresAt: 0,
		scopes: ['account:read'],
	}
	borrowedExternal.current = null
	replaceBorrowed.mockClear()
	readStored.mockClear()
	writeStored.mockClear()
	replaceStored.mockClear()
	runCalls.queries.length = 0
	runCalls.resumes.length = 0
	constructedTokens.length = 0
	vi.spyOn(ProviderRegistry, 'create').mockImplementation(((config: Record<string, unknown>) => {
		const token = String(config.authToken ?? config.apiKey ?? '')
		constructedTokens.push(token)
		return { provider: { id: 'recording-provider', token } }
	}) as never)
})

afterEach(async () => {
	vi.unstubAllGlobals()
	for (const open of sessions.splice(0)) await open.close()
	for (const root of roots.splice(0)) removeTempDir(root)
	vi.restoreAllMocks()
})

describe('a run owns the token refresh that precedes it', () => {
	it('refreshes an expired Claude session and publishes its rotating grant before query', async () => {
		borrowedExternal.current = {
			accessToken: 'cc-borrowed',
			refreshToken: 'rt-owned-by-claude',
			expiresAt: Date.now() - 1,
		}
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						access_token: 'cc-borrowed-fresh',
						refresh_token: 'rt-borrowed-successor',
						expires_in: 3_600,
					}),
					{ status: 200 },
				),
		)
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await borrowedSession()

		await agent
			.send([createUserMessage('must wait for claude login')])
			[Symbol.asyncIterator]()
			.next()

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(replaceBorrowed).toHaveBeenCalledWith(
			'/tmp/.claude/.credentials.json',
			expect.objectContaining({ accessToken: 'cc-borrowed' }),
			expect.objectContaining({
				accessToken: 'cc-borrowed-fresh',
				refreshToken: 'rt-borrowed-successor',
			}),
		)
		expect(borrowedExternal.current).toEqual(
			expect.objectContaining({ accessToken: 'cc-borrowed-fresh' }),
		)
		expect(runCalls.queries.map(providerToken)).toEqual(['cc-borrowed-fresh'])
		expect(constructedTokens).toEqual(['cc-borrowed', 'cc-borrowed-fresh'])
	})

	it('cancels an uncooperative refresh before send reaches query', async () => {
		let requestSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string | URL | Request, init?: RequestInit) => {
				requestSignal = init?.signal ?? undefined
				return new Promise<Response>(() => {})
			}),
		)
		const agent = await session()
		const controller = new AbortController()
		const cause = new Error('interactive turn stopped')
		const next = agent
			.send([createUserMessage('hello')], { signal: controller.signal })
			[Symbol.asyncIterator]()
			.next()
		await vi.waitFor(() => expect(requestSignal).toBeDefined())

		controller.abort(cause)

		await expect(within(next)).rejects.toBe(cause)
		expect(requestSignal?.aborted).toBe(true)
		expect(requestSignal?.reason).toBe(cause)
		expect(runCalls.queries).toHaveLength(0)
		expect(writeStored).not.toHaveBeenCalled()
	})

	it('cancels an uncooperative refresh before durable resume reaches the kernel', async () => {
		let requestSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string | URL | Request, init?: RequestInit) => {
				requestSignal = init?.signal ?? undefined
				return new Promise<Response>(() => {})
			}),
		)
		const agent = await session()
		const controller = new AbortController()
		const cause = new Error('durable claim withdrawn')
		const pending = agent.resumeDurable({
			entry: durableEntry('cancelled'),
			checkpointStore: {} as never,
			signal: controller.signal,
		})
		await vi.waitFor(() => expect(requestSignal).toBeDefined())

		controller.abort(cause)

		await expect(within(pending)).rejects.toBe(cause)
		expect(requestSignal?.reason).toBe(cause)
		expect(runCalls.resumes).toHaveLength(0)
		expect(writeStored).not.toHaveBeenCalled()
	})
})

describe('one session publishes refresh state in order', () => {
	it('caches invalid_grant for the exact credential across send and resume', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), {
					status: 400,
				}),
		)
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()

		const send = agent
			.send([createUserMessage('first attempt')])
			[Symbol.asyncIterator]()
			.next()
		await expect(send).rejects.toBeInstanceOf(CredentialRefreshRejectedError)
		await expect(
			agent.resumeDurable({
				entry: durableEntry('same-rejected-grant'),
				checkpointStore: {} as never,
			}),
		).rejects.toBeInstanceOf(CredentialRefreshRejectedError)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(runCalls.queries).toEqual([])
		expect(runCalls.resumes).toEqual([])
		expect(constructedTokens).toEqual(['cc-old'])
	})

	it('shares one permanent refresh refusal across concurrent owners', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'INVALID_GRANT' }), {
					status: 400,
				}),
		)
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()

		const send = agent
			.send([createUserMessage('concurrent send')])
			[Symbol.asyncIterator]()
			.next()
		const resume = agent.resumeDurable({
			entry: durableEntry('concurrent-rejected-grant'),
			checkpointStore: {} as never,
		})

		await expect(send).rejects.toBeInstanceOf(CredentialRefreshRejectedError)
		await expect(resume).rejects.toBeInstanceOf(CredentialRefreshRejectedError)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(runCalls.queries).toEqual([])
		expect(runCalls.resumes).toEqual([])
	})

	it('lets a fresh authoritative credential bypass an older permanent refusal', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), {
					status: 400,
				}),
		)
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()
		const first = agent
			.send([createUserMessage('old grant')])
			[Symbol.asyncIterator]()
			.next()
		await expect(first).rejects.toBeInstanceOf(CredentialRefreshRejectedError)

		stored.current = {
			accessToken: 'cc-new-login',
			refreshToken: 'rt-new-login',
			expiresAt: Date.now() + 3_600_000,
		}
		await agent.resumeDurable({
			entry: durableEntry('after-new-login'),
			checkpointStore: {} as never,
		})

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(constructedTokens).toEqual(['cc-old', 'cc-new-login'])
		expect(runCalls.resumes.map(providerToken)).toEqual(['cc-new-login'])
	})

	it('treats deletion after invalid_grant as withdrawal, never as a cache miss', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'invalid_grant' }), {
					status: 400,
				}),
		)
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()
		const first = agent
			.send([createUserMessage('grant will be withdrawn')])
			[Symbol.asyncIterator]()
			.next()
		await expect(first).rejects.toBeInstanceOf(CredentialRefreshRejectedError)

		stored.current = null
		const second = agent
			.send([createUserMessage('must not use memory token')])
			[Symbol.asyncIterator]()
			.next()
		await expect(second).rejects.toBeInstanceOf(CredentialWithdrawnError)
		await expect(
			agent.resumeDurable({
				entry: durableEntry('after-withdrawal'),
				checkpointStore: {} as never,
			}),
		).rejects.toBeInstanceOf(CredentialWithdrawnError)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(runCalls.queries).toEqual([])
		expect(runCalls.resumes).toEqual([])
		expect(constructedTokens).toEqual(['cc-old'])
	})

	it('refuses an unproven CAS and lets the next operation adopt its durable winner', async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ access_token: 'cc-unproven' }), {
					status: 200,
				}),
		)
		vi.stubGlobal('fetch', fetchSpy)
		replaceStored.mockImplementationOnce(() => {
			throw new Error('credential store lock is held by another writer')
		})
		const agent = await session()

		await expect(
			agent.resumeDurable({
				entry: durableEntry('busy-cas'),
				checkpointStore: {} as never,
			}),
		).rejects.toBeInstanceOf(CredentialPublicationError)
		expect(constructedTokens).toEqual(['cc-old'])
		expect(runCalls.resumes).toHaveLength(0)

		stored.current = {
			accessToken: 'cc-after-busy-winner',
			refreshToken: 'rt-after-busy-winner',
			expiresAt: Date.now() + 3_600_000,
		}
		await agent.resumeDurable({
			entry: durableEntry('after-busy'),
			checkpointStore: {} as never,
		})

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(writeStored).not.toHaveBeenCalled()
		expect(constructedTokens).toEqual(['cc-old', 'cc-after-busy-winner'])
		expect(runCalls.resumes.map(providerToken)).toEqual(['cc-after-busy-winner'])
	})

	it('stops when logout removes the credential during refresh', async () => {
		let releaseBody: () => void = () => {}
		const bodyGate = new Promise<void>((resolve) => {
			releaseBody = resolve
		})
		const fetchSpy = vi.fn(async () => {
			await bodyGate
			return new Response(JSON.stringify({ access_token: 'cc-after-logout' }), {
				status: 200,
			})
		})
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()
		const pending = agent.resumeDurable({
			entry: durableEntry('logged-out'),
			checkpointStore: {} as never,
		})
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

		stored.current = null
		releaseBody()

		await expect(pending).rejects.toBeInstanceOf(CredentialWithdrawnError)
		expect(stored.current).toBeNull()
		expect(writeStored).not.toHaveBeenCalled()
		expect(constructedTokens).toEqual(['cc-old'])
		expect(runCalls.resumes).toHaveLength(0)
	})

	it('lets an external durable rotation win over a late refresh response', async () => {
		let releaseBody: () => void = () => {}
		const bodyGate = new Promise<void>((resolve) => {
			releaseBody = resolve
		})
		const fetchSpy = vi.fn(async () => {
			await bodyGate
			return new Response(
				JSON.stringify({
					access_token: 'cc-derived-from-old',
					refresh_token: 'rt-derived',
				}),
				{ status: 200 },
			)
		})
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()
		const pending = agent.resumeDurable({
			entry: durableEntry('external-winner'),
			checkpointStore: {} as never,
		})
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

		stored.current = {
			accessToken: 'cc-external-winner',
			refreshToken: 'rt-external-winner',
			expiresAt: Date.now() + 3_600_000,
		}
		releaseBody()
		await pending

		expect(replaceStored).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: 'cc-old',
				scopes: ['account:read'],
			}),
			expect.objectContaining({ accessToken: 'cc-derived-from-old' }),
		)
		expect(writeStored).not.toHaveBeenCalled()
		expect(stored.current?.accessToken).toBe('cc-external-winner')
		expect(constructedTokens).toEqual(['cc-old', 'cc-external-winner'])
		expect(runCalls.resumes.map(providerToken)).toEqual(['cc-external-winner'])
	})

	it('never lets a late sibling downgrade a successfully rotated provider', async () => {
		let releaseFirst: () => void = () => {}
		let releaseConcurrentFailure: () => void = () => {}
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const concurrentFailureGate = new Promise<void>((resolve) => {
			releaseConcurrentFailure = resolve
		})
		const fetchSpy = vi.fn(async () => {
			const call = fetchSpy.mock.calls.length
			if (call === 1) {
				await firstGate
				return new Response(
					JSON.stringify({
						access_token: 'cc-fresh',
						refresh_token: 'rt-fresh',
						expires_in: 3600,
					}),
					{ status: 200 },
				)
			}
			// Reachable only if both owners read the stale credential before A
			// publishes it. Hold the failure until A is observably durable.
			await concurrentFailureGate
			return new Response('late refusal', { status: 500 })
		})
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()

		const first = agent.resumeDurable({
			entry: durableEntry('a'),
			checkpointStore: {} as never,
		})
		const second = agent.resumeDurable({
			entry: durableEntry('b'),
			checkpointStore: {} as never,
		})
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
		releaseFirst()
		await vi.waitFor(() => expect(writeStored).toHaveBeenCalled())
		releaseConcurrentFailure()

		await Promise.all([first, second])

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(readStored).toHaveBeenCalledTimes(2)
		expect(stored.current?.accessToken).toBe('cc-fresh')
		expect(constructedTokens).toEqual(['cc-old', 'cc-fresh'])
		expect(runCalls.resumes.map(providerToken)).toEqual(['cc-fresh', 'cc-fresh'])
	})

	it('lets an aborted waiter leave promptly without opening the queue behind it', async () => {
		let releaseFirst: () => void = () => {}
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const fetchSpy = vi.fn(async () => {
			await firstGate
			return new Response(
				JSON.stringify({
					access_token: 'cc-fresh',
					refresh_token: 'rt-fresh',
					expires_in: 3600,
				}),
				{ status: 200 },
			)
		})
		vi.stubGlobal('fetch', fetchSpy)
		const agent = await session()
		const first = agent.resumeDurable({
			entry: durableEntry('owner'),
			checkpointStore: {} as never,
		})
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

		const controller = new AbortController()
		const cause = new Error('queued claim expired')
		const cancelled = agent.resumeDurable({
			entry: durableEntry('waiter'),
			checkpointStore: {} as never,
			signal: controller.signal,
		})
		controller.abort(cause)
		await expect(within(cancelled)).rejects.toBe(cause)

		const third = agent.resumeDurable({
			entry: durableEntry('behind-waiter'),
			checkpointStore: {} as never,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(runCalls.resumes).toHaveLength(0)

		releaseFirst()
		await Promise.all([first, third])

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(readStored).toHaveBeenCalledTimes(2)
		expect(runCalls.resumes.map(providerToken)).toEqual(['cc-fresh', 'cc-fresh'])
	})
})
