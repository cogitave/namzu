import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionTextEvidenceSearchResult } from '../../../store/evidence/types.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * One session log holds every turn of a session, so the evidence a running
 * turn captures is the session's: the turns before it as well as its own
 * records so far. A capture narrowed to the running turn could never answer
 * the question capture exists for — what did this conversation record
 * earlier — and a host that reads the log directly instead loses the anchor
 * that keeps the turn's own appends from invalidating its reads.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

it('captures the earlier turns of the session, not only the running one', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-capture-session-'))
	dirs.push(workingDirectory)
	const scope = {
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
	const turn = (provider: MockLLMProvider, tools: ToolRegistry, content: string) =>
		drainQuery({
			provider,
			tools,
			agentId: 'capture-session',
			agentName: 'Capture session',
			messages: [{ role: 'user', content }],
			workingDirectory,
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: 3,
				permissionMode: 'auto',
			},
			...scope,
		})

	const first = await turn(
		new MockLLMProvider({ turns: [{ text: 'The receipt number is ORCHID-4417.' }] }),
		new ToolRegistry(),
		'What is the receipt number?',
	)
	expect(first.status).toBe('completed')

	let found: SessionTextEvidenceSearchResult | undefined
	const tools = new ToolRegistry()
	tools.register({
		name: 'look_back',
		description: 'Search what this session recorded earlier.',
		inputSchema: z.object({}),
		execute: async (_input, context) => {
			const source = await context.captureSessionEvidence?.()
			if (!source) throw new Error('This turn has no session log to capture.')
			expect(source.scope).toEqual({
				tenantId: scope.tenantId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
			})
			found = await source.search({ query: 'ORCHID-4417' })
			return { success: true, output: 'Looked back.' }
		},
	})
	const second = await turn(
		new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'look', name: 'look_back', args: {} }] },
				{ text: 'It was ORCHID-4417.' },
			],
		}),
		tools,
		'What was that receipt number again?',
	)

	expect(second.status).toBe('completed')
	expect(found?.matches.map((match) => match.excerpt)).toContain(
		'The receipt number is ORCHID-4417.',
	)
	// The running turn has not settled, so the capture cannot claim the whole log.
	expect(found?.incomplete).toBe(true)
})
