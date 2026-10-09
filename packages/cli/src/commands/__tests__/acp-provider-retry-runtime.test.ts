import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionTokenBudgetStore,
	type SessionEvent,
	abandonTurn,
	asSessionId,
	createAssistantMessage,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import type { TurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { closeSessions, loadConversation, openSessions } from '../../integrations/sessions/store.js'
import type { ResumePausedParams, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'
import { providerPaused } from './support/provider-paused.js'

let root: string
let state: Awaited<ReturnType<typeof openSessions>>
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-provider-retry-runtime-'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	state = await openSessions(root, { stateRoot: join(root, 'state') })
})
afterEach(() => {
	closeSessions(state)
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function fixture({ ownedPal = false, unresolved = false, limit = 0 } = {}) {
	const f = await providerPaused(state, { unresolved, limit })
	let route: ((event: SessionEvent) => void) | undefined
	let busy = false
	let finish = false
	let review: unknown
	let generation = 1
	let environmentId = 'original-guest'
	let computerReady = true
	let operator = false
	let duringSend: (() => void) | undefined
	let duringResume: (() => void) | undefined
	const resume = vi.fn((params: ResumePausedParams) =>
		(async function* () {
			duringResume?.()
			await params.assertExecutionAllowed?.()
			if (params.onPermission)
				review = await params.onPermission({
					toolCalls: [{ id: 'write', name: 'write', input: {}, isDestructive: true }],
				} as never)
			route?.({
				type: 'text_delta',
				sessionId: f.sessionId,
				turnId: f.turnId,
				iteration: 1,
				messageId: generateMessageId(),
				text: 'Resumed',
			})
			if (finish) {
				const lease = (await f.log.claim({ holder: 'retry-completion', ttlMs: 60_000 }))!
				try {
					await f.log.append(lease, {
						type: 'turn_resuming',
						turnId: f.turnId,
						fromCheckpointId: f.checkpointId,
					})
					await f.log.append(lease, {
						type: 'message',
						turnId: f.turnId,
						messageId: generateMessageId(),
						role: 'assistant',
						content: createAssistantMessage('The original robot task is ready'),
					})
					await f.log.append(lease, {
						type: 'turn_completed',
						turnId: f.turnId,
						result: 'The original robot task is ready',
						settlement: {
							status: 'completed',
							iterations: 2,
							usage: {
								promptTokens: 4,
								completionTokens: 2,
								totalTokens: 6,
								cachedTokens: 0,
								cacheWriteTokens: 0,
							},
							cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
							durationMs: 1,
							resultSource: 'model',
							abandonedTaskIds: [],
							abandonedJobIds: [],
						},
					})
				} finally {
					await f.log.release(lease)
				}
			}
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})(),
	)
	const send = vi.fn((_messages: unknown, options: SendOptions) =>
		(async function* () {
			await options.assertExecutionAllowed?.()
			duringSend?.()
			yield {
				kind: 'paused',
				turnId: f.turnId,
				checkpointId: f.checkpointId,
				reason: 'Provider temporarily unavailable',
			} as const
		})(),
	)
	const createSession = vi.fn(
		async (
			_prefs: unknown,
			_detected: unknown,
			options: { onSessionEvent?: (event: SessionEvent) => void },
		) => {
			route = options.onSessionEvent
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send,
				resumePaused: resume,
				abandonTurn: (turnId: TurnId, reason: string) =>
					abandonTurn(f.sessionId, turnId, reason, { log: f.log }),
				reasoningEffortLevels: ['low', 'high'],
				reasoningEffortDefault: 'low',
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
			}
		},
	)
	const pal = {
		id: 'owned-pal',
		name: 'Fixture',
		workspace: root,
		purpose: '',
		revision: 1,
		model: null,
		paused: false,
		createdAt: '',
		updatedAt: '',
	}
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
						entry: { id: 'zen', label: 'Zen', defaultModel: 'original-model' },
						apiKey: 'synthetic',
					},
				],
				needsRepickReason: null,
			}),
			createSession,
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async (sessionId: string) => ({ sessionId: asSessionId(sessionId) }),
			openSessions: (cwd: string) => openSessions(cwd, { stateRoot: join(root, 'state') }),
			...(ownedPal
				? {
						palBinding: async () => ({ pal, definition: pal, sessionId: f.sessionId }),
						palRuntime: async () => ({
							computer: () =>
								computerReady
									? { palId: pal.id, generation, environmentId, sandbox: { status: 'ready' } }
									: null,
							computerControl: () => ({ supported: true, mode: operator ? 'operator' : 'pal' }),
							busy: () => busy,
						}),
					}
				: {}),
		} as unknown as AcpRuntimeDependencies,
	)
	const ask = vi.fn(async () => ({ kind: 'reject' as const, feedback: 'Keep the human choice' }))
	const onEvent = vi.fn()
	const context = {
		sessionId: f.sessionId,
		cwd: root,
		signal: new AbortController().signal,
		onEvent,
		ask,
		history: [],
		filesystem: undefined,
	}
	const pause = (options?: Parameters<typeof runtime.gateway.prompt>[0]['options']) =>
		runtime.gateway.prompt({ ...context, prompt: 'Original request', options })
	const retry = (
		options?: Parameters<typeof runtime.gateway.prompt>[0]['options'],
		turnId = f.turnId,
	) => runtime.gateway.retry!({ ...context, turnId, checkpointId: f.checkpointId, options })
	return {
		...f,
		runtime,
		resume,
		send,
		createSession,
		ask,
		onEvent,
		pause,
		retry,
		review: () => review,
		busy: () => {
			busy = true
		},
		finish: () => {
			finish = true
		},
		changeGeneration: () => {
			generation += 1
		},
		changeEnvironment: () => {
			environmentId = 'replacement-guest'
		},
		setComputerReady: (ready: boolean) => {
			computerReady = ready
		},
		takeover: () => {
			operator = true
		},
		duringSend: (callback: () => void) => {
			duringSend = callback
		},
		duringResume: (callback: () => void) => {
			duringResume = callback
		},
	}
}

describe('CLI explicit provider retry composition', () => {
	it.each([false, true])(
		'preserves the exact paused approval, effort and model with ownedPal=%s',
		async (ownedPal) => {
			const f = await fixture({ ownedPal })
			try {
				await f.pause({ permissionMode: 'plan', effort: 'high' })
				expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
					retry: { turnId: f.turnId, checkpointId: f.checkpointId },
				})
				f.finish()
				const outcome = await f.retry()
				expect(f.resume.mock.calls[0]?.[0]).toMatchObject({
					turnId: f.turnId,
					checkpointId: f.checkpointId,
					permissionMode: 'plan',
					model: { provider: 'zen', model: 'original-model', effort: 'high' },
				})
				expect(f.resume.mock.calls[0]?.[0]).not.toHaveProperty('pendingDecision')
				expect(f.ask).toHaveBeenCalledOnce()
				expect(f.review()).toEqual({ kind: 'reject', feedback: 'Keep the human choice' })
				expect(f.onEvent).toHaveBeenCalledWith(
					expect.objectContaining({ type: 'text_delta', turnId: f.turnId }),
				)
				expect(outcome.history).toHaveLength(2)
				expect((await loadConversation(state, f.sessionId)).map((row) => row.role)).toEqual([
					'user',
					'assistant',
				])
				expect(f.send).toHaveBeenCalledOnce()
				expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({})
			} finally {
				await f.runtime.close()
			}
		},
	)
	it('closes a paused provider turn without repeating it, keeping unknown usage recorded', async () => {
		const f = await fixture({ unresolved: true, limit: 1_000_000 })
		try {
			await f.pause({ permissionMode: 'auto' })
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				notice: expect.stringContaining('actual provider usage receipt'),
			})
			await expect(
				f.runtime.abandonPausedTurn!(f.sessionId, root, generateTurnId()),
			).rejects.toThrow('no paused turn')
			expect(await f.runtime.abandonPausedTurn!(f.sessionId, root, f.turnId)).toEqual({
				closed: true,
			})
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({})
			expect(f.resume).not.toHaveBeenCalled()
			const store = new DiskSessionTokenBudgetStore({ paths: state.paths })
			const ledger = await store.load(f.budgetScope)
			expect(
				[...(ledger?.requests ?? []), ...(ledger?.completedRequests ?? [])].filter(
					(request) => request.unresolved,
				),
			).toHaveLength(1)
		} finally {
			await f.runtime.close()
		}
	})
	it('retains automatic own-computer approval without restoring an ordinary default', async () => {
		const f = await fixture({ ownedPal: true })
		try {
			await f.pause()
			await f.retry()
			expect(f.resume.mock.calls[0]?.[0].permissionMode).toBe('auto')
		} finally {
			await f.runtime.close()
		}
	})
	it('retries in place when a conversation with no limit has unknown usage for one request', async () => {
		const f = await fixture({ unresolved: true })
		try {
			await f.pause({ permissionMode: 'auto' })
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				retry: { turnId: f.turnId, checkpointId: f.checkpointId },
				unknownUsage: 1,
			})
			await f.retry()
			expect(f.resume).toHaveBeenCalledOnce()
		} finally {
			await f.runtime.close()
		}
	})
	it('rejects an obsolete turn and unresolved accounting under a limit before resume', async () => {
		const f = await fixture({ unresolved: true, limit: 1_000_000 })
		try {
			await f.pause({ permissionMode: 'auto' })
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				notice: expect.stringContaining('actual provider usage receipt'),
			})
			await expect(f.retry()).rejects.toThrow('actual provider usage receipt')
			expect(f.resume).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
		const safe = await fixture()
		try {
			await safe.pause()
			await expect(safe.retry(undefined, generateTurnId())).rejects.toThrow('changed')
			expect(safe.resume).not.toHaveBeenCalled()
		} finally {
			await safe.runtime.close()
		}
	})
	it('refuses unknown original approval settings after reconnect unless explicitly selected', async () => {
		const f = await fixture()
		try {
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				notice: expect.stringContaining('original approval settings'),
			})
			await expect(f.retry()).rejects.toThrow('explicit permission mode')
			await f.retry({ permissionMode: 'strict', effort: 'low' })
			expect(f.resume.mock.calls[0]?.[0]).toMatchObject({
				permissionMode: 'strict',
				model: { provider: 'zen', model: 'original-model', effort: 'low' },
			})
			expect(f.send).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})
	it.each(['generation', 'environment', 'retired', 'operator'] as const)(
		'refuses an old Pal checkpoint after its original computer changes: %s',
		async (change) => {
			const f = await fixture({ ownedPal: true })
			try {
				await f.pause({ permissionMode: 'auto', effort: 'low' })
				if (change === 'generation') f.changeGeneration()
				if (change === 'environment') f.changeEnvironment()
				if (change === 'retired') f.setComputerReady(false)
				if (change === 'operator') f.takeover()
				expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
					notice: expect.stringContaining('original Pal computer'),
				})
				await expect(f.retry({ permissionMode: 'auto' })).rejects.toThrow('original Pal computer')
				expect(f.resume).not.toHaveBeenCalled()
			} finally {
				await f.runtime.close()
			}
		},
	)
	it('uses the pre-send lifetime even when the computer changes before the pause arrives', async () => {
		const f = await fixture({ ownedPal: true })
		try {
			f.duringSend(f.changeGeneration)
			await f.pause()
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				notice: expect.stringContaining('original Pal computer'),
			})
			await expect(f.retry()).rejects.toThrow('original Pal computer')
			expect(f.resume).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})
	it('checks the pinned original lifetime again inside resumed provider/tool admission', async () => {
		const f = await fixture({ ownedPal: true })
		try {
			await f.pause()
			f.duringResume(f.changeEnvironment)
			await expect(f.retry()).rejects.toThrow('original Pal computer')
			expect(f.resume).toHaveBeenCalledOnce()
			expect(f.resume.mock.calls[0]?.[0].assertExecutionAllowed).toBeTypeOf('function')
			expect(f.ask).not.toHaveBeenCalled()
			expect(f.onEvent).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})
	it('never attaches a cold or originally offline Pal turn to a currently ready computer', async () => {
		const cold = await fixture({ ownedPal: true })
		try {
			expect(await cold.runtime.providerRetryStatus!(cold.sessionId, root)).toEqual({
				notice: expect.stringContaining('original Pal computer lifetime cannot be verified'),
			})
			await expect(cold.retry({ permissionMode: 'auto' })).rejects.toThrow(
				'original Pal computer lifetime',
			)
			expect(cold.resume).not.toHaveBeenCalled()
		} finally {
			await cold.runtime.close()
		}
		const offline = await fixture({ ownedPal: true })
		try {
			offline.setComputerReady(false)
			await offline.pause()
			offline.setComputerReady(true)
			await expect(offline.retry({ permissionMode: 'auto' })).rejects.toThrow(
				'original Pal computer lifetime',
			)
			expect(offline.resume).not.toHaveBeenCalled()
		} finally {
			await offline.runtime.close()
		}
	})
	it('reports another live Pal conversation before advertising Retry', async () => {
		const f = await fixture({ ownedPal: true })
		try {
			await f.pause()
			f.busy()
			expect(await f.runtime.providerRetryStatus!(f.sessionId, root)).toEqual({
				notice: expect.stringContaining('current work'),
			})
			expect(f.resume).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})
	it('advertises recovery extensions only when both durable status and ACP retry are implemented', async () => {
		const f = await fixture()
		try {
			expect(createDesktopHostExtensions(f.runtime, root)).not.toHaveProperty(
				'namzu/sessions/retry',
			)
			expect(createDesktopHostExtensions(f.runtime, root, undefined, vi.fn())).toHaveProperty(
				'namzu/sessions/retry',
			)
		} finally {
			await f.runtime.close()
		}
	})
	it('dispatches only exact trusted project sessions and rejects new prompt payloads', async () => {
		const f = await fixture()
		const retryOwner = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
		const host = createDesktopHostExtensions(f.runtime, root, undefined, retryOwner)
		try {
			host['namzu/project/trust']({ cwd: root, confirmed: true })
			await f.pause({ permissionMode: 'plan' })
			expect(await host['namzu/sessions/retry-status']!({ sessionId: f.sessionId })).toEqual({
				retry: { turnId: f.turnId, checkpointId: f.checkpointId },
			})
			await expect(
				host['namzu/sessions/retry']!({
					sessionId: generateSessionId(),
					turnId: f.turnId,
					checkpointId: f.checkpointId,
				}),
			).rejects.toThrow('does not belong')
			await expect(
				host['namzu/sessions/retry']!({
					sessionId: f.sessionId,
					turnId: f.turnId,
					checkpointId: f.checkpointId,
					prompt: 'A new authored request',
				}),
			).rejects.toThrow('original turn')
			expect(retryOwner).not.toHaveBeenCalled()
			await host['namzu/sessions/retry']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				checkpointId: f.checkpointId,
				options: { permissionMode: 'plan' },
			})
			expect(retryOwner).toHaveBeenCalledWith(f.sessionId, f.turnId, f.checkpointId, {
				permissionMode: 'plan',
			})
		} finally {
			await f.runtime.close()
		}
	})
})
