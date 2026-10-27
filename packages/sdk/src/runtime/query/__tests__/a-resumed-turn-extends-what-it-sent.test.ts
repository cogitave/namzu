import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import {
	type Message,
	createTurnContextEntry,
	createUserMessage,
	isTurnContextEntry,
	turnContextEntries,
} from '../../../types/message/index.js'
import type { PrepareStepContext, PrepareStepResult } from '../../../types/session/index.js'
import { resumeSession } from '../resume-session.js'
import { TEST_SCOPE, recordTypes, sessionWithCheckpoint } from './support/session.js'

/**
 * A turn picked back up in another process rebuilds its history from the
 * log. Recorded context comes back as the entries that were written, so the
 * first request after the resume begins with everything the interrupted one
 * held, and a step that reads its entries does not say them again.
 */

let dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs = []
})

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

describe('a resumed turn', () => {
	it('sends the entries it recorded before, unchanged, and records nothing twice', async () => {
		const entry = createTurnContextEntry('repository', 'REPO STATE')
		const held = [createUserMessage('the work so far'), entry]
		const session = await sessionWithCheckpoint({ messages: held, release: true })
		const dir = await realpath(await mkdtemp(join(tmpdir(), 'namzu-resume-entries-')))
		dirs.push(dir)
		const provider = new MockLLMProvider({ turns: [{ text: 'continued' }] })

		const outcome = await resumeSession({
			scope: { ...TEST_SCOPE, sessionId: session.sessionId, turnId: session.turnId },
			sessionLog: session.log,
			checkpointStore: session.store,
			provider,
			toolsets: [],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
			agentId: 'agent_resume',
			agentName: 'Resume Agent',
			workingDirectory: dir,
			sessionId: session.sessionId,
			topicId: TEST_SCOPE.topicId,
			projectId: TEST_SCOPE.projectId,
			tenantId: TEST_SCOPE.tenantId,
			resumeHandler: async () => ({ action: 'continue' as const }),
			prepareStep: ({ messages }: PrepareStepContext): PrepareStepResult =>
				turnContextEntries(messages, 'repository').length === 0
					? { recordedContext: [{ key: 'repository', text: 'REPO STATE' }] }
					: {},
		})
		expect(outcome.resumed).toBe(true)

		const sent = provider.requests[0]?.messages as Message[]
		const start = sent.map((m) => `${m.role}:${text(m)}`)
		const before = held.map((m) => `${m.role}:${text(m)}`)
		// Both held messages come back in order, the entry right after the prompt.
		expect(start.slice(0, before.length + 1).filter((l) => before.includes(l))).toEqual(before)
		expect(start.filter((line) => line.includes('the work so far'))).toHaveLength(1)
		// The entry is the one the log held, not a second copy.
		expect(sent.filter(isTurnContextEntry)).toHaveLength(1)
		expect(text(sent.find(isTurnContextEntry) as Message)).toBe(text(entry))
		expect(await recordTypes(session.log)).not.toContain('compaction')
	})
})
