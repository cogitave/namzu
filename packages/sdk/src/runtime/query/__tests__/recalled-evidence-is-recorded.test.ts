import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import {
	type EvidenceRecallCandidate,
	type EvidenceRecallRequest,
	createEvidenceRecallStep,
} from '../../../turn/evidence-recall.js'
import { type Message, isTurnContextEntry, turnContextKey } from '../../../types/message/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The real conversation-evidence step with `record`, driven through two turns
 * of a tool loop. The passages are recorded once, after the operator message;
 * the second turn's first request begins with the whole of the first turn's
 * last request and adds only passages it has not said.
 */

registerMock()

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)

describe('recalled evidence recorded across turns', () => {
	it('records a passage once and lets the next turn extend the last request byte for byte', async () => {
		const ids = {
			tenantId: fixtureId.tenant('ev-rec'),
			projectId: fixtureId.project('ev-rec'),
			sessionId: fixtureId.session('ev-rec'),
			topicId: fixtureId.topic('ev-rec'),
		}
		const earlier = generateTurnId()
		const entry = (seq: number, excerpt: string): EvidenceRecallCandidate => ({
			scope: {
				tenantId: ids.tenantId,
				projectId: ids.projectId,
				sessionId: ids.sessionId,
				turnId: earlier,
			},
			seq,
			part: 0,
			source: 'tool_completed',
			toolName: 'read',
			retained: 'full',
			excerpt,
			byteOffset: 0,
		})
		const archive: EvidenceRecallCandidate[] = [entry(1, 'DELTA tracking code: A17')]
		const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
			candidates: [...archive],
			scannedBytes: 64,
			incomplete: false,
		}))
		const tools = testToolset({
			name: 'look',
			description: 'Look at something',
			inputSchema: z.object({ what: z.string() }),
			execute: async () => ({ success: true, output: 'seen' }),
		})
		const prepareStep = createEvidenceRecallStep({
			scope: { tenantId: ids.tenantId, projectId: ids.projectId, sessionId: ids.sessionId },
			retrieve,
			record: true,
		})
		const turn = (provider: MockLLMProvider, messages: Message[]) =>
			drainQuery({
				toolsets: [tools],
				agentId: 'a',
				agentName: 'A',
				systemPrompt: 'You are a coding agent.',
				workingDirectory: process.cwd(),
				turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
				compactionConfig: CompactionConfigSchema.parse({}),
				...ids,
				provider,
				prepareStep,
				messages,
				retry: false,
			})

		const first = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
				{ toolCalls: [{ id: 'c2', name: 'look', args: { what: 'y' } }] },
				{ text: 'done' },
			],
		})
		const one = await turn(first, [{ role: 'user', content: 'what was the DELTA tracking code' }])

		// Read once for the turn; recorded once; after the operator message.
		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(first.requests).toHaveLength(3)
		const entries = one.messages.filter(isTurnContextEntry)
		expect(entries).toHaveLength(1)
		expect(turnContextKey(entries[0] as Message)).toBe('evidence')
		const lines = shape(first.requests[0]?.messages as Message[])
		const asked = lines.findIndex((line) => line.includes('what was the DELTA tracking code'))
		expect(lines[asked + 1]).toContain('A17')
		for (const [i, request] of first.requests.entries()) {
			if (i === 0) continue
			const before = shape(first.requests[i - 1]?.messages as Message[])
			expect(shape(request.messages as Message[]).slice(0, before.length)).toEqual(before)
		}

		// A new passage lands; the next turn adds it and nothing else.
		archive.push(entry(2, 'DELTA tracking code: B99'))
		const second = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		const lastOfFirst = shape(first.requests.at(-1)?.messages as Message[])
		await turn(second, [
			...one.messages,
			{ role: 'user', content: 'and the later DELTA tracking code?' } as Message,
		])
		expect(retrieve).toHaveBeenCalledTimes(2)
		const opening = shape(second.requests[0]?.messages as Message[])
		expect(opening.slice(0, lastOfFirst.length)).toEqual(lastOfFirst)
		const added = opening.slice(lastOfFirst.length).join('\n')
		expect(added).toContain('B99')
		expect(added).not.toContain('A17')
	})
})
