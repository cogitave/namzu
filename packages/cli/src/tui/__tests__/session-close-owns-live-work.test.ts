import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionLog } from '../../__fixtures__/session-log.js'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { SessionOperationOwner, createAgentSession } from '../agent.js'

function registryNames(registry: unknown): readonly string[] | undefined {
	return (registry as { names(): readonly string[] } | undefined)?.names()
}

const operations = vi.hoisted(() => ({
	calls: [] as Array<{
		kind: 'send' | 'compact' | 'resume'
		signal: AbortSignal | undefined
		pluginManager?: unknown
		skillRegistry?: unknown
		skills?: readonly { metadata?: { name?: string } }[]
	}>,
	order: [] as string[],
	releases: [] as Array<() => void>,
	subagentToolName: 'Agent' as string,
	subagentCloseError: undefined as Error | undefined,
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	const hold = (
		kind: 'send' | 'compact' | 'resume',
		signal: AbortSignal | undefined,
		details: Omit<(typeof operations.calls)[number], 'kind' | 'signal'> = {},
	) => {
		operations.calls.push({ kind, signal, ...details })
		return new Promise<void>((resolve, reject) => {
			let settled = false
			const finish = (settle: () => void) => {
				if (settled) return
				settled = true
				signal?.removeEventListener('abort', onAbort)
				operations.order.push(`${kind}-settled`)
				settle()
			}
			const onAbort = () => finish(() => reject(signal?.reason))
			operations.releases.push(() => finish(resolve))
			if (signal?.aborted) onAbort()
			else signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	return {
		...actual,
		query: (params: {
			signal?: AbortSignal
			pluginManager?: unknown
			skillRegistry?: unknown
			skills?: readonly { metadata?: { name?: string } }[]
		}) => {
			operations.calls.push({ kind: 'send', ...params, signal: params.signal })
			return (async function* () {
				try {
					yield {
						type: 'text_delta',
						turnId: '87f8e385-8e27-4622-ba76-750282582c15',
						iteration: 1,
						messageId: 'ceb65f4b-38dd-4540-8fca-ce160e9dbd38',
						text: 'started',
					} as never
				} finally {
					operations.order.push('query-cleanup-start')
					yield {
						type: 'sandbox_destroyed',
						turnId: '87f8e385-8e27-4622-ba76-750282582c15',
						sandboxId: '6f53f078-01e4-456a-af15-c94ae082667a',
					} as never
					operations.order.push('query-cleanup-finished')
					operations.order.push('send-settled')
				}
				return { messages: [], status: 'completed' } as never
			})()
		},
		compactNow: async (input: { signal?: AbortSignal }) => {
			await hold('compact', input.signal)
			return null
		},
		resumeSession: async (params: {
			signal?: AbortSignal
			pluginManager?: unknown
			skillRegistry?: unknown
			skills?: readonly { metadata?: { name?: string } }[]
		}) => {
			await hold('resume', params.signal, params)
			return { resumed: false, reason: 'no-checkpoint' } as const
		},
	}
})

vi.mock('../../integrations/mcp/servers.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/mcp/servers.js')>()
	return {
		...actual,
		connectMcpServers: vi.fn(async () => ({
			tools: [],
			toolsets: [],
			connected: [],
			failed: [],
			close: async () => {
				operations.order.push('mcp-close')
			},
		})),
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gatewayForTurn: async () => ({}) as never,
		completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
		releaseTurn: async () => {},
		agentTool: {
			name: operations.subagentToolName,
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		waitForTaskTool: {
			name: 'wait_for_task',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
		close: async () => {
			operations.order.push('subagent-close')
			if (operations.subagentCloseError) throw operations.subagentCloseError
		},
	}),
}))

let cwd: string

beforeEach(() => {
	operations.calls.length = 0
	operations.order.length = 0
	operations.releases.length = 0
	operations.subagentToolName = 'Agent'
	operations.subagentCloseError = undefined
	cwd = mkdtempSync(join(tmpdir(), 'namzu-session-owner-'))
})

afterEach(() => {
	for (const release of operations.releases.splice(0)) release()
	removeTempDir(cwd)
})

async function waitForCalls(count: number): Promise<void> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		if (operations.calls.length >= count) return
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(`Only ${operations.calls.length}/${count} session operations started.`)
}

describe('AgentSession close owns its live work', () => {
	it.each([false, true])('closes a refused subagent runtime (cleanup fails: %s)', async (fails) => {
		operations.subagentToolName = 'invalid name'
		if (fails) operations.subagentCloseError = new Error('Subagent did not drain')
		const creation = createAgentSession(
			{
				version: 3,
				providers: [{ id: 'anthropic' }],
				subagents: { active: [] },
			} as Preferences,
			[
				{
					entry: {
						id: 'anthropic',
						label: 'Anthropic',
						defaultModel: 'a-model',
						requiresApiKey: true,
						envVars: ['ANTHROPIC_API_KEY'],
					},
					source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
					apiKey: 'not-a-real-key',
					alternatives: [],
				} as unknown as DetectedProvider,
			],
			{ cwd },
		)

		if (fails) {
			const error = await creation.catch((error: unknown) => error)
			expect(error).toBeInstanceOf(AggregateError)
			expect(error).toMatchObject({
				message: 'Subagent startup cleanup failed.',
				errors: [expect.any(Error), operations.subagentCloseError],
			})
			expect(operations.order).toEqual(['subagent-close', 'mcp-close'])
			return
		}
		const session = await creation
		expect(session.hasProvider).toBe(true)
		expect(operations.order.filter((event) => event === 'subagent-close')).toHaveLength(1)
		await session.close()
		expect(operations.order.filter((event) => event === 'subagent-close')).toHaveLength(1)
	})

	it('keeps exclusive resource changes owned until settled and refuses new work', async () => {
		const cleanup = vi.fn(async () => {})
		const owner = new SessionOperationOwner(cleanup)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const change = owner.exclusive(async () => {
			await gate
		})
		await expect(owner.promise(undefined, async () => {})).rejects.toThrow(/plugin change/)
		await expect(owner.exclusive(async () => {})).rejects.toThrow(/active session operation/)
		const stream = owner
			.stream(undefined, async function* () {
				yield 1
			})
			[Symbol.asyncIterator]()
		await expect(stream.next()).rejects.toThrow(/plugin change/)
		const closing = owner.close()
		await Promise.resolve()
		expect(cleanup).not.toHaveBeenCalled()
		release()
		await change
		await closing
		expect(cleanup).toHaveBeenCalledOnce()
		await expect(owner.exclusive(async () => {})).rejects.toThrow(/closed/i)
	})

	it('releases the resource-change gate after failure', async () => {
		const owner = new SessionOperationOwner(async () => {})
		await expect(
			owner.exclusive(async () => {
				throw new Error('load failed')
			}),
		).rejects.toThrow('load failed')
		await expect(owner.promise(undefined, async () => 'usable')).resolves.toBe('usable')
		await owner.close()
	})

	it('keeps a stream owned when throw and return yield cleanup values', async () => {
		const order: string[] = []
		const owner = new SessionOperationOwner(async () => {
			order.push('resource-close')
		})
		const stream = owner
			.stream(undefined, () =>
				(async function* () {
					try {
						yield 'ready'
					} catch {
						yield 'caught'
					} finally {
						order.push('cleanup-start')
						yield 'cleanup'
						order.push('cleanup-finished')
					}
				})(),
			)
			[Symbol.asyncIterator]()

		await expect(stream.next()).resolves.toEqual({
			done: false,
			value: 'ready',
		})
		await expect(stream.throw?.(new Error('consumer injection'))).resolves.toEqual({
			done: false,
			value: 'caught',
		})

		await owner.close()
		expect(order).toEqual(['cleanup-start', 'cleanup-finished', 'resource-close'])
	})

	it('cancels and settles send, compact and resume before resource teardown', async () => {
		const preferences = {
			version: 3,
			providers: [{ id: 'anthropic' }],
			subagents: { active: [] },
		} as Preferences
		const detected = [
			{
				entry: {
					id: 'anthropic',
					label: 'Anthropic',
					defaultModel: 'a-model',
					requiresApiKey: true,
					envVars: ['ANTHROPIC_API_KEY'],
				},
				source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
				apiKey: 'not-a-real-key',
				alternatives: [],
			} as unknown as DetectedProvider,
		]
		const pluginDir = join(cwd, '.namzu', 'plugins', 'owner', 'skills', 'settle')
		mkdirSync(pluginDir, { recursive: true })
		writeFileSync(
			join(cwd, '.namzu', 'plugins', 'owner', 'plugin.json'),
			JSON.stringify({
				name: 'owner',
				version: '1.0.0',
				description: 'session ownership fixture',
				skills: ['skills/settle'],
			}),
		)
		writeFileSync(
			join(pluginDir, 'SKILL.md'),
			'---\nname: settle\ndescription: settle session work\n---\n\nOwned body.\n',
		)
		const session = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: ['project'] },
			// The plugin's skill alone, without the built-in tier beside it.
			skills: { builtin: false },
		})
		const sendCaller = new AbortController()
		const resumeCaller = new AbortController()
		const stream = session
			.send([createUserMessage('hold this turn')], {
				signal: sendCaller.signal,
			})
			[Symbol.asyncIterator]()
		await expect(stream.next()).resolves.toMatchObject({
			done: false,
			value: { kind: 'delta', text: 'started' },
		})
		const compactOutcome = session.compact([]).catch((error: unknown) => error)
		const resumeOutcome = session
			.resumeDurable({
				// A different turn from the one `send` is running: one turn
				// cannot be streamed and resumed at once, and the session's
				// review channels are keyed by turn.
				entry: {
					turnId: '0199a7c1-2d3e-7f40-8a51-b62c73d84e95',
					sessionId: 'e987235a-edbf-4a98-bff1-f27a58cd7862',
					projectId: '242a64d9-0216-4eb0-8d5d-cb832ccd4c21',
					tenantId: 'a88f05eb-ba3a-4fef-9942-801a712acff6',
				} as never,
				sessionLog: emptySessionLog(undefined),
				checkpointStore: {} as never,
				signal: resumeCaller.signal,
			})
			.catch((error: unknown) => error)

		await waitForCalls(3)
		const sendCall = operations.calls.find((call) => call.kind === 'send')
		const resumeCall = operations.calls.find((call) => call.kind === 'resume')
		expect(sendCall?.pluginManager).toBeDefined()
		expect(resumeCall?.pluginManager).toBe(sendCall?.pluginManager)
		// Each turn gets its own merged view (file skills gated per turn), over
		// the same plugin registry: both resolve the plugin's skill.
		expect(registryNames(resumeCall?.skillRegistry)).toEqual(registryNames(sendCall?.skillRegistry))
		expect(registryNames(sendCall?.skillRegistry)).toContain('owner__settle')
		expect(sendCall?.skills?.map((skill) => skill.metadata?.name)).toEqual(['owner__settle'])
		expect(resumeCall?.skills?.map((skill) => skill.metadata?.name)).toEqual(['owner__settle'])
		const close = session.close()
		expect(session.close()).toBe(close)
		// No real 1000ms safety race: it competed with the same clock as the
		// close-owns-live-work behaviour it waited on (each operation settles
		// once `close()` aborts its signal), so a starved CI runner could
		// make that work outlast the guard with nothing actually broken. A
		// regression that left this unresolved now hangs and fails on
		// Vitest's own per-test timeout instead.
		await Promise.all([close, compactOutcome, resumeOutcome])

		expect(sendCaller.signal.aborted).toBe(false)
		expect(resumeCaller.signal.aborted).toBe(false)
		for (const call of operations.calls) {
			expect(call.signal?.aborted, call.kind).toBe(true)
			expect(call.signal?.reason, call.kind).toMatchObject({
				name: 'AbortError',
				message: 'Agent session closed.',
			})
		}
		const mcpClose = operations.order.indexOf('mcp-close')
		const subagentClose = operations.order.indexOf('subagent-close')
		expect(mcpClose).toBeGreaterThan(-1)
		expect(subagentClose).toBeGreaterThan(-1)
		for (const event of [
			'query-cleanup-start',
			'query-cleanup-finished',
			'send-settled',
			'compact-settled',
			'resume-settled',
		]) {
			const eventIndex = operations.order.indexOf(event)
			expect(eventIndex, `${event} was observed`).toBeGreaterThan(-1)
			expect(eventIndex, `${event} preceded MCP close`).toBeLessThan(mcpClose)
			expect(eventIndex, `${event} preceded subagent close`).toBeLessThan(subagentClose)
		}
		// The turn's view reads the plugin registry live, and close emptied it.
		expect(registryNames(sendCall?.skillRegistry)).toEqual([])
		await expect(
			(
				sendCall?.pluginManager as
					| {
							executeHooks(event: string, context: unknown): Promise<readonly unknown[]>
					  }
					| undefined
			)?.executeHooks('pre_llm_call', {
				sessionId: 'e987235a-edbf-4a98-bff1-f27a58cd7862' as never,
				turnId: 'c3b59814-a47c-41d7-b2bc-eacd7363d69f' as never,
			}),
		).resolves.toEqual([])

		const callsAfterClose = operations.calls.length
		await expect(session.compact([])).rejects.toThrow('Agent session closed')
		await expect(
			session.resumeDurable({
				entry: {} as never,
				sessionLog: emptySessionLog(undefined),
				checkpointStore: {} as never,
			}),
		).rejects.toThrow('Agent session closed')
		await expect(session.send([])[Symbol.asyncIterator]().next()).rejects.toThrow(
			'Agent session closed',
		)
		expect(operations.calls).toHaveLength(callsAfterClose)
	})
})
