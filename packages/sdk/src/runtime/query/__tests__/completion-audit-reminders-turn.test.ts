import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { COMPLETION_AUDIT_MESSAGE } from '../turn/completion-audit.js'

/** Each reminder wording, from a scripted turn whose tools report what they did as typed facts. */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function run(turns: MockTurn[], completionAudit: boolean) {
	const provider = new MockLLMProvider({ turns })
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-audit-'))
	dirs.push(workingDirectory)
	const edit = testToolset({
		name: 'edit',
		description: 'edit',
		inputSchema: z.object({ path: z.string().optional() }),
		execute: async () => ({ success: true, output: 'ok' }),
	})
	// A command that contains "FAIL" exits 1; every other exits 0.
	const bash = testToolset({
		name: 'bash',
		description: 'bash',
		inputSchema: z.object({ command: z.string() }),
		execute: async (input) => {
			const failed = input.command.includes('FAIL')
			return {
				success: !failed,
				output: failed ? 'failed' : 'ok',
				...(failed ? { error: 'exit 1' } : {}),
				facts: { kind: 'command' as const, command: input.command, exitCode: failed ? 1 : 0 },
			}
		},
	})
	const turn = await drainQuery(
		{
			provider,
			toolsets: [edit, bash],
			turnConfig: {
				model: 'm',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 12,
				maxResponseTokens: 2_000,
				...(completionAudit ? { completionAudit: true } : {}),
			},
			agentId: 'agent_a',
			agentName: 'Audit',
			messages: [createUserMessage('fix the bug')],
			workingDirectory,
			sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
			tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
			retry: false,
		},
		() => {},
	)
	return { turn, provider }
}

const edited: MockTurn = { toolCalls: [{ name: 'edit', args: { path: 'a.ts' } }] }
const bashCall = (command: string): MockTurn => ({
	toolCalls: [{ name: 'bash', args: { command } }],
})

/** Every runtime-context nudge the model was shown, across all requests, de-duplicated by text. */
function nudges(provider: MockLLMProvider): string[] {
	const seen = new Set<string>()
	for (const request of provider.requests) {
		for (const message of request.messages) {
			if (typeof message.content !== 'string') continue
			if (
				message.content === COMPLETION_AUDIT_MESSAGE ||
				/exit status hidden|changed after it|failed in this turn/.test(message.content)
			) {
				seen.add(message.content)
			}
		}
	}
	return [...seen]
}
const lastRequestCount = (provider: MockLLMProvider, text: string) =>
	provider.requests[provider.requests.length - 1]?.messages.filter((m) => m.content === text).length

describe('the one reminder, through a real turn', () => {
	it('a check piped through tail gets the hidden-status wording', async () => {
		const piped = 'npm test 2>&1 | tail -15'
		const { provider } = await run(
			[edited, bashCall(piped), { text: 'done' }, { text: 'ok' }],
			true,
		)
		const [only] = nudges(provider)
		expect(nudges(provider)).toHaveLength(1)
		expect(only).toContain(`\`${piped}\``)
		expect(only).toContain('without the pipe')
		expect(lastRequestCount(provider, only ?? '')).toBe(1)
	})

	it('a check that passed and then went stale gets the stale wording', async () => {
		const { provider } = await run(
			[edited, bashCall('pnpm test'), edited, { text: 'done' }, { text: 'ok' }],
			true,
		)
		const [only] = nudges(provider)
		expect(nudges(provider)).toHaveLength(1)
		expect(only).toContain('`pnpm test` passed')
	})

	it('a failing check gets the failing wording and names it', async () => {
		const { provider } = await run(
			[edited, bashCall('pnpm test FAIL'), { text: 'done' }, { text: 'ok' }],
			true,
		)
		const [only] = nudges(provider)
		expect(nudges(provider)).toHaveLength(1)
		expect(only).toContain('`pnpm test FAIL` failed')
	})

	it('no check at all still gets the original message', async () => {
		const { provider } = await run([edited, { text: 'done' }, { text: 'ok' }], true)
		expect(nudges(provider)).toEqual([COMPLETION_AUDIT_MESSAGE])
	})

	it('is asked once even when a second problem appears after the reminder', async () => {
		const { turn, provider } = await run(
			[
				edited,
				bashCall('pnpm test | tail -5'),
				{ text: 'done' },
				bashCall('pnpm lint FAIL'),
				{ text: 'again' },
				{ text: 'final' },
			],
			true,
		)
		expect(nudges(provider)).toHaveLength(1)
		expect(turn.result).toBe('again')
	})

	it('says nothing with the audit off', async () => {
		const { provider } = await run([edited, bashCall('pnpm test | tail'), { text: 'done' }], false)
		expect(nudges(provider)).toEqual([])
	})

	it('says nothing when nothing changed, even after a failing check', async () => {
		const { provider } = await run([bashCall('pnpm test FAIL'), { text: 'done' }], true)
		expect(nudges(provider)).toEqual([])
	})
})
