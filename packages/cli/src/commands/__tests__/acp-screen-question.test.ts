import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentSession, SendOptions } from '../../tui/agent.js'
import { screenApprover } from '../../tui/computer-use-screen-approval.js'
import { SCREEN_MOMENT_TOOL, questionsOverPermission } from '../acp-screen-question.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/**
 * The "screen needed for a moment" question, from the ladder's approver to the permission request
 * a Desktop client receives and back. Nothing here touches a desktop or real time.
 */

type Outcome = { kind: 'approve' } | { kind: 'approve_all' } | { kind: 'reject' }
type Seen = { sessionId: string; toolCalls: Record<string, unknown>[] }

const subject = { app: 'Editor', exe: 'editor.exe' }
const never = new AbortController().signal

describe('the screen question over the permission request', () => {
	it('sends one always-ask call naming the application, and reads the answer as the ladder does', async () => {
		const seen: Seen[] = []
		const answer = (outcome: Outcome) => async (request: Seen) => {
			seen.push(request)
			return outcome
		}
		for (const [outcome, expected] of [
			[{ kind: 'approve' }, 'allow'],
			[{ kind: 'approve_all' }, 'allow'],
			[{ kind: 'reject' }, 'deny'],
		] as [Outcome, string][]) {
			const ask = questionsOverPermission('s1', answer(outcome) as never, never)
			await expect(screenApprover(() => ask)(subject)).resolves.toBe(expected)
		}
		expect(seen[0]).toEqual({
			sessionId: 's1',
			toolCalls: [
				{
					id: 'screen-moment-1',
					name: SCREEN_MOMENT_TOOL,
					input: { app: 'Editor' },
					isDestructive: false,
					alwaysAsk: true,
				},
			],
		})
	})

	it('never answers yes for a client that fails, and waits for a still moment instead', async () => {
		const ask = questionsOverPermission(
			's1',
			(async () => {
				throw new Error('connection closed')
			}) as never,
			never,
		)
		await expect(screenApprover(() => ask)(subject)).resolves.toBe('unavailable')
	})

	it('reads a stopped turn as no, and does not ask a stopped turn', async () => {
		const turn = new AbortController()
		const request = vi.fn()
		const ask = questionsOverPermission('s1', request as never, turn.signal)
		turn.abort()
		await expect(screenApprover(() => ask)(subject)).resolves.toBe('deny')
		expect(request).not.toHaveBeenCalled()
	})

	it('stops waiting when the ladder does, without answering yes', async () => {
		const waiting = new AbortController()
		const ask = questionsOverPermission('s1', (() => new Promise(() => {})) as never, never)
		const result = screenApprover(() => ask)(subject, waiting.signal)
		waiting.abort()
		await expect(result).resolves.toBe('unavailable')
	})

	it('skips a question that is not the screen one', async () => {
		const request = vi.fn()
		const ask = questionsOverPermission('s1', request as never, never)
		await expect(
			ask({ questionId: 'q1', question: 'Which file?', options: [] } as never),
		).resolves.toEqual({ kind: 'skip' })
		expect(request).not.toHaveBeenCalled()
	})
})

describe('the runtime wiring', () => {
	let root: string
	let cwd: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-acp-screen-question-'))
		cwd = join(root, 'project')
		mkdirSync(cwd)
		mkdirSync(join(root, 'state'))
		vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		removeTempDir(root)
	})

	async function turn(computerUse: boolean) {
		let verdict: string | undefined
		let hadQuestion = false
		const send = vi.fn((_messages: unknown, options: SendOptions) =>
			(async function* () {
				hadQuestion = options.onQuestion !== undefined
				if (options.onQuestion) verdict = await screenApprover(() => options.onQuestion)(subject)
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
			{ computerUse },
		)
		const ask = vi.fn(async () => ({ kind: 'reject' as const }))
		try {
			await runtime.gateway.prompt({
				sessionId: 'session-1',
				cwd,
				prompt: 'x',
				history: [],
				signal: new AbortController().signal,
				onEvent() {},
				ask,
				filesystem: undefined,
			})
		} finally {
			await runtime.close()
		}
		return { ask, verdict, hadQuestion }
	}

	it('gives a Desktop turn the channel, and the person answer comes back as no', async () => {
		const { ask, verdict } = await turn(true)
		expect(verdict).toBe('deny')
		const calls = (ask.mock.calls[0] as unknown as [Seen])[0].toolCalls
		expect(calls[0]).toMatchObject({ name: SCREEN_MOMENT_TOOL, alwaysAsk: true })
	})

	it('leaves a bare ACP client with no question channel', async () => {
		const { hadQuestion, ask } = await turn(false)
		expect(hadQuestion).toBe(false)
		expect(ask).not.toHaveBeenCalled()
	})
})
