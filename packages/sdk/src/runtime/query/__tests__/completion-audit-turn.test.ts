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

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function run(turns: MockTurn[], completionAudit: boolean) {
	const provider = new MockLLMProvider({ turns })
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-audit-'))
	dirs.push(workingDirectory)
	const tool = (name: string) =>
		testToolset({
			name,
			description: name,
			inputSchema: z.object({ command: z.string().optional() }),
			execute: async () => ({ success: true, output: 'ok' }),
		})
	const turn = await drainQuery(
		{
			provider,
			toolsets: [tool('edit'), tool('bash')],
			turnConfig: {
				model: 'm',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 10,
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

const edited: MockTurn = { toolCalls: [{ name: 'edit', args: {} }] }
const checked: MockTurn = { toolCalls: [{ name: 'bash', args: { command: 'pnpm test' } }] }

const reminders = (provider: MockLLMProvider) =>
	provider.requests.map(
		(r) =>
			r.messages.filter(
				(m) => typeof m.content === 'string' && m.content === COMPLETION_AUDIT_MESSAGE,
			).length,
	)

describe('a turn that edited files and ends without a check', () => {
	it('is asked once to check, then may end however it answers', async () => {
		const { turn, provider } = await run([edited, { text: 'done' }, { text: 'done again' }], true)
		expect(reminders(provider)).toEqual([0, 0, 1])
		expect(turn.result).toBe('done again')
	})

	it('ends at once when a check followed the edit', async () => {
		const { turn, provider } = await run([edited, checked, { text: 'done' }], true)
		expect(reminders(provider)).toEqual([0, 0, 0])
		expect(turn.result).toBe('done')
	})

	it('is not asked when the audit is off', async () => {
		const { turn, provider } = await run([edited, { text: 'done' }], false)
		expect(reminders(provider)).toEqual([0, 0])
		expect(turn.result).toBe('done')
	})
})
