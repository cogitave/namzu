import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { DiskSessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { defineTool } from '../../../tools/defineTool.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

const LINES = Array.from({ length: 4000 }, (_, i) => `line ${i} of the long output`)

const big = defineTool({
	name: 'big',
	description: 'Returns far more text than the output budget allows',
	inputSchema: z.object({}),
	category: 'custom',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	async execute() {
		return { success: true, output: LINES.join('\n') }
	},
})

async function run(withRead: boolean) {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-saved-output-'))
	directories.push(directory)
	const sessionId = generateSessionId()
	const sessionDir = join(directory, sessionId)
	const saved = join(
		sessionDir,
		'tool-results',
		`${createHash('sha256').update('c1').digest('hex')}.txt`,
	)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'big', args: {} }] },
			...(withRead
				? [
						{
							toolCalls: [
								{ id: 'c2', name: 'read', args: { path: saved, offset: 3000, limit: 2 } },
							],
						},
					]
				: []),
			{ text: 'done' },
		],
	})
	const turn = await drainQuery({
		provider,
		toolsets: [testToolset(...(withRead ? [big, ReadFileTool] : [big]))],
		agentId: 'saved-output',
		agentName: 'Saved output',
		messages: [{ role: 'user' as const, content: 'go' }],
		workingDirectory: directory,
		projectId: generateProjectId(),
		sessionId,
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnId: generateTurnId(),
		sessionLog: new DiskSessionLog({
			sessionId,
			file: join(directory, `${sessionId}.jsonl`),
			sessionDir,
		}),
		turnConfig: { model: 'mock', tokenBudget: 1_000_000, maxIterations: 5, timeoutMs: 0 },
		maxToolOutputChars: 1000,
		toolTimeoutMs: 0,
		repeatCallAdvisory: false,
	})
	return { turn, saved }
}

const toolText = (turn: Awaited<ReturnType<typeof run>>['turn'], id: string): string => {
	const message = turn.messages.find((m) => m.role === 'tool' && m.toolCallId === id)
	return String(message?.content ?? '')
}

describe("a cut tool output and the turn's own read tool", () => {
	it('points at the saved file with the read tool, and read opens it without a question', async () => {
		const { turn, saved } = await run(true)

		const cut = toolText(turn, 'c1')
		expect(cut).toContain(saved)
		expect(cut).toContain('open this file with the read tool')
		expect(cut).not.toContain('search_conversation')
		expect(toolText(turn, 'c2')).toContain('line 3000 of the long output')
	})

	it('does not name the read tool when the turn has none', async () => {
		const { turn } = await run(false)

		const cut = toolText(turn, 'c1')
		expect(cut).toContain('The full output was written to:')
		expect(cut).not.toContain('read tool')
	})
})
