import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { SessionOperationOwner, createAgentSession } from '../agent.js'

const operations = vi.hoisted(() => ({
	calls: [] as Array<{
		kind: 'send' | 'compact' | 'resume'
		signal: AbortSignal | undefined
	}>,
	order: [] as string[],
	releases: [] as Array<() => void>,
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	const hold = (kind: 'send' | 'compact' | 'resume', signal: AbortSignal | undefined) => {
		operations.calls.push({ kind, signal })
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
		query: (params: { signal?: AbortSignal }) => {
			operations.calls.push({ kind: 'send', signal: params.signal })
			return (async function* () {
				try {
					yield {
						type: 'text_delta',
						runId: 'run_owned',
						iteration: 1,
						messageId: 'msg_owned',
						text: 'started',
					} as never
				} finally {
					operations.order.push('query-cleanup-start')
					yield {
						type: 'sandbox_destroyed',
						runId: 'run_owned',
						sandboxId: 'sbx_owned',
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
		resumeRun: async (params: { signal?: AbortSignal }) => {
			await hold('resume', params.signal)
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
		gateway: {} as unknown,
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let cwd: string

beforeEach(() => {
	operations.calls.length = 0
	operations.order.length = 0
	operations.releases.length = 0
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

		await expect(stream.next()).resolves.toEqual({ done: false, value: 'ready' })
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
		const session = await createAgentSession(preferences, detected, { cwd })
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
				entry: {
					runId: 'run_owned',
					sessionId: 'ses_owned',
					projectId: 'prj_owned',
					tenantId: 'tnt_owned',
				} as never,
				checkpointStore: {} as never,
				signal: resumeCaller.signal,
			})
			.catch((error: unknown) => error)

		await waitForCalls(3)
		const close = session.close()
		expect(session.close()).toBe(close)
		const allSettled = Promise.all([close, compactOutcome, resumeOutcome])
		const safety = Symbol('session close left live work pending')
		const outcome = await Promise.race([
			allSettled,
			new Promise<typeof safety>((resolve) => setTimeout(() => resolve(safety), 1_000)),
		])
		try {
			expect(outcome).not.toBe(safety)
		} finally {
			if (outcome === safety) {
				for (const release of operations.releases) release()
				await allSettled
			}
		}

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
		expect(mcpClose).toBeGreaterThan(-1)
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
		}

		const callsAfterClose = operations.calls.length
		await expect(session.compact([])).rejects.toThrow('Agent session closed')
		await expect(
			session.resumeDurable({
				entry: {} as never,
				checkpointStore: {} as never,
			}),
		).rejects.toThrow('Agent session closed')
		await expect(session.send([])[Symbol.asyncIterator]().next()).rejects.toThrow(
			'Agent session closed',
		)
		expect(operations.calls).toHaveLength(callsAfterClose)
	})
})
