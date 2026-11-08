import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentSession, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/**
 * The first look at the screen is a question that belongs to the request, not
 * to a call, so the ask `namzu acp` hands its client marks every call of that
 * request `alwaysAsk`; a client's "allow for this conversation" then cannot
 * answer it. The marking is the CLI's wiring (`ToolReviewRequest.screenConsent`
 * into `withPreviews`), so it is checked here at the seam, not in `withPreviews`
 * alone.
 */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-screen-consent-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const ordinary = { id: 'c1', name: 'screenshot', input: {}, isDestructive: false }

async function askedFor(request: Record<string, unknown>) {
	let review: unknown
	const send = vi.fn((_messages: unknown, options: SendOptions) =>
		(async function* () {
			review = await options.onPermission?.(request as never)
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})(),
	) as unknown as AgentSession['send']
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		{
			probe: async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				detected: [],
			}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (value: unknown) => value,
			resolveSession: async (sessionId: string) => ({ sessionId }),
			createSession: async () => ({
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				send,
				close: async () => {},
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
				jobs: () => [],
			}),
		} as unknown as AcpRuntimeDependencies,
	)
	const ask = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		await runtime.gateway.prompt({
			sessionId: 'session-1',
			cwd,
			prompt: 'Look at the screen',
			history: [],
			signal: new AbortController().signal,
			onEvent() {},
			ask,
			filesystem: undefined,
		})
	} finally {
		await runtime.close()
	}
	return { ask, review }
}

describe('the ask a client receives for a turn', () => {
	it('marks every call of a request that is the first look at the screen', async () => {
		const { ask, review } = await askedFor({
			toolCalls: [ordinary, { ...ordinary, id: 'c2' }],
			screenConsent: true,
		})
		expect(ask).toHaveBeenCalledOnce()
		const calls = (ask.mock.calls[0] as unknown as [{ toolCalls: { alwaysAsk?: true }[] }])[0]
			.toolCalls
		expect(calls).toHaveLength(2)
		expect(calls.every((call) => call.alwaysAsk === true)).toBe(true)
		expect(review).toEqual({ kind: 'approve' })
	})

	it('leaves an ordinary call unmarked', async () => {
		const { ask } = await askedFor({ toolCalls: [ordinary] })
		const calls = (ask.mock.calls[0] as unknown as [{ toolCalls: { alwaysAsk?: true }[] }])[0]
			.toolCalls
		expect(calls[0]).not.toHaveProperty('alwaysAsk')
	})
})
