import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The whole path from `query({ additionalDirectories })` to the tool's
 * context, through the tooling seam that copies executor config fields by
 * name. A unit test on the tool alone passed while this seam dropped the
 * list; this one runs the query.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function readThroughQuery(added: boolean) {
	const base = await mkdtemp(join(tmpdir(), 'namzu-add-dir-'))
	dirs.push(base)
	const cwd = join(base, 'project')
	const shared = join(base, 'shared')
	await mkdir(cwd)
	await mkdir(shared)
	await writeFile(join(shared, 'lib.txt'), 'from the shared directory')
	const tools = new ToolRegistry()
	tools.register(ReadFileTool)
	const call: MockTurn = {
		toolCalls: [{ id: 'r1', name: 'read', args: { path: join(shared, 'lib.txt') } }],
		finishReason: 'tool_calls',
	}
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		tools,
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('read it')],
		workingDirectory: cwd,
		...(added ? { additionalDirectories: [shared] } : {}),
		sessionId: 'ses_d' as SessionId,
		topicId: 'top_d' as TopicId,
		projectId: 'prj_d' as ProjectId,
		tenantId: 'tnt_d' as TenantId,
	})
	return result.messages
		.filter((m: Message) => m.role === 'tool' && typeof m.content === 'string')
		.map((m: Message) => m.content as string)
}

describe('an added directory', () => {
	it('reaches the tools through the query', async () => {
		const [text] = await readThroughQuery(true)
		expect(text).toContain('from the shared directory')
	})

	it('is not reachable when the query did not add it', async () => {
		const [text] = await readThroughQuery(false)
		expect(text).toMatch(/escapes the working directory/)
	})
})
