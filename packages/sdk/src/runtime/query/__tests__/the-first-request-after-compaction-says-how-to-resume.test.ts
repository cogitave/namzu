import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { COMPACTION_HEADER, COMPACTION_RESUME_NOTE } from '../../../compaction/summary.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

registerMock()
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const scope = {
	projectId: fixtureId.project('resume-note'),
	sessionId: fixtureId.session('resume-note'),
	topicId: fixtureId.topic('resume-note'),
	tenantId: fixtureId.tenant('resume-note'),
}

/** What the model is handed right after history was folded into a summary. */
describe('the first request after a compaction', () => {
	it('carries one summary that closes on the resume note', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-resume-note-'))
		dirs.push(dir)
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const events: SessionEvent[] = []
		await drainQuery(
			{
				...scope,
				provider,
				toolsets: [],
				sessionLog: new InMemorySessionLog({ sessionId: scope.sessionId }),
				agentId: 'resume-note',
				agentName: 'Resume note',
				workingDirectory: dir,
				turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 3 },
				compactionConfig: CompactionConfigSchema.parse({
					strategy: 'structured',
					contextWindowTokens: 1_000,
					llmVerification: false,
					clearToolResults: false,
					keepRecentMessages: 2,
				}),
				messages: [
					createUserMessage('FIRST_REQUEST'),
					createAssistantMessage(`Earlier work. ${'background '.repeat(800)}`),
					createUserMessage('SECOND_REQUEST'),
					createAssistantMessage(`More work. ${'context '.repeat(800)}`),
					createUserMessage('THIRD_REQUEST'),
				],
			},
			(event) => {
				events.push(event)
			},
		)

		expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
		const summaries = (provider.requests[0]?.messages ?? []).filter(
			(m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER),
		)
		expect(summaries).toHaveLength(1)
		const text = String(summaries[0]?.content)
		expect(text.endsWith(`\n\n${COMPACTION_RESUME_NOTE}`)).toBe(true)
		expect(text.split(COMPACTION_RESUME_NOTE)).toHaveLength(2)
	})
})
