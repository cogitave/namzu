import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { TurnOutcomeConfig } from '../../../types/session/outcome.js'
import { drainQuery } from '../index.js'

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

async function run(beforeEnd: NonNullable<TurnOutcomeConfig['beforeEnd']>) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-before-end-'))
	workdirs.push(workingDirectory)
	const sessionId = '6b8c1b28-3cdf-4873-9cb3-dd0401d912c7' as SessionId
	const provider = new MockLLMProvider({ turns: [{ text: 'an answer' }] })
	const turn = await drainQuery(
		{
			provider,
			toolsets: [],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 60,
				maxResponseTokens: 256,
				outcome: { beforeEnd },
			},
			agentId: 'agent_before_end',
			agentName: 'Agent',
			messages: [createUserMessage('hello')],
			workingDirectory,
			sessionId,
			topicId: 'b8388597-184a-4544-916e-1e5fb3e6bc97' as TopicId,
			projectId: 'ddfe0aea-433a-4b7c-ba63-c7301ab2a1ff' as ProjectId,
			tenantId: 'f0ed1aa3-0d7e-498a-8d91-e5197b22922d' as TenantId,
			sessionLog: new InMemorySessionLog({ sessionId }),
		},
		() => {},
	)
	return { turn, requests: provider.requests.length }
}

describe('the host hook before a turn ends', () => {
	it('sends the model back once with the note it returned, then lets the turn end', async () => {
		let asked = 0
		const { turn, requests } = await run(() => (++asked === 1 ? 'Say it again.' : undefined))
		expect(turn.status).toBe('completed')
		expect(requests).toBe(2)
		expect(asked).toBe(2)
	})

	it('hands over the record only when it is asked for', async () => {
		let read: unknown = 'never read'
		await run(async (record) => {
			read = await record()
			return undefined
		})
		expect(read).toMatchObject({ verdict: 'unchanged', basis: 'calls' })
		let asked = false
		await run(() => {
			asked = true
			return undefined
		})
		expect(asked).toBe(true)
	})

	it('treats a hook that throws as nothing to say', async () => {
		const { turn, requests } = await run(() => {
			throw new Error('the hook broke')
		})
		expect(turn.status).toBe('completed')
		expect(requests).toBe(1)
	})

	it('stops honouring a hook that never lets go, after sixteen notes', async () => {
		const { turn, requests } = await run(() => 'Again.')
		expect(turn.status).toBe('completed')
		expect(requests).toBe(17)
	})
})
