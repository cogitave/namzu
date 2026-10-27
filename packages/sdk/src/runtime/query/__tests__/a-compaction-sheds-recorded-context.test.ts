import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { compactNow } from '../../../compaction/manual.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { evidenceTexts } from '../../../store/session-index/fts.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import {
	type Message,
	createUserMessage,
	isTurnContextEntry,
	turnContextEntries,
} from '../../../types/message/index.js'
import type { PrepareStepContext, PrepareStepResult } from '../../../types/session/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { generateTurnId } from '../../../utils/id.js'
import { compactSession } from '../compact-session.js'
import { drainQuery } from '../index.js'

/**
 * A compaction pass sheds recorded context with the history around it. The
 * step then finds no earlier entry and says its piece in full once, the
 * shed entries are not indexed as things said in the session, and the
 * entry list that comes back is still a plain extension of itself.
 */

registerMock()

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

function session(name: string) {
	const sessionId = fixtureId.session(name)
	return {
		toolsets: [],
		agentId: 'a',
		agentName: 'A',
		systemPrompt: 'You are a coding agent.',
		workingDirectory: process.cwd(),
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		compactionConfig: CompactionConfigSchema.parse({}),
		tenantId: fixtureId.tenant(name),
		projectId: fixtureId.project(name),
		sessionId,
		topicId: fixtureId.topic(name),
		sessionLog: new InMemorySessionLog({ sessionId }),
		retry: false as const,
	}
}

/** Says its whole piece when it has no earlier entry, nothing otherwise. */
const saysOnce = ({ messages }: PrepareStepContext): PrepareStepResult =>
	turnContextEntries(messages, 'repository').length === 0
		? { recordedContext: [{ key: 'repository', text: 'REPO STATE' }] }
		: {}

describe('recorded context across a compaction', () => {
	it('is said in full once after a pass sheds it, and the shed entry is not evidence', async () => {
		const base = session('shed-entries')
		const provider = new MockLLMProvider({ responseText: 'an answer' })
		let history: readonly Message[] = []
		for (let turn = 1; turn <= 3; turn++) {
			const run = await drainQuery({
				...base,
				provider,
				prepareStep: saysOnce,
				turnId: generateTurnId(),
				messages: [...history, createUserMessage(`question ${turn}: enough text to be a message`)],
			})
			expect(run.status).toBe('completed')
			history = (await readFoldedHistory(base.sessionLog)).map((entry) => entry.message)
		}
		// Said once for the whole of the first three turns.
		expect(history.filter(isTurnContextEntry)).toHaveLength(1)

		const config = CompactionConfigSchema.parse({
			strategy: 'structured',
			keepRecentMessages: 2,
			clearToolResults: false,
			llmVerification: false,
		})
		// What a pass sheds, as the evidence index would be handed it.
		const shed: Message[] = []
		await compactNow({
			messages: history,
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config,
			onShed: (messages) => {
				shed.push(...messages)
			},
		})
		expect(shed.some(isTurnContextEntry)).toBe(true)
		const indexed = evidenceTexts({
			type: 'compaction_shed',
			messages: shed,
		} as unknown as SessionRecord).map((t) => t.text)
		expect(indexed.some((t) => t.includes('question 1'))).toBe(true)
		expect(indexed.some((t) => t.includes('REPO STATE'))).toBe(false)

		const compacted = await compactSession({
			sessionId: base.sessionId,
			locator: { log: base.sessionLog },
			provider: new MockLLMProvider({ responseText: 'unused' }),
			config,
		})
		expect(compacted?.shed).toBeGreaterThan(0)

		// The entry went with the older history.
		const kept = (await readFoldedHistory(base.sessionLog)).map((entry) => entry.message)
		expect(kept.filter(isTurnContextEntry)).toHaveLength(0)

		// The next turn finds no earlier entry and says it in full, once.
		const before = provider.requests.length
		await drainQuery({
			...base,
			provider,
			prepareStep: saysOnce,
			turnId: generateTurnId(),
			messages: [...kept, createUserMessage('question 4: enough text to be a message')],
		})
		const sent = provider.requests.slice(before).flatMap((r) => r.messages as Message[])
		expect(sent.filter(isTurnContextEntry).map(text)).toEqual([
			expect.stringContaining('REPO STATE'),
		])
	})
})
