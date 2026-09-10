import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import { drainQuery } from '../index.js'

it('carries a successful write across query turns and refuses an edit after external drift', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cross-turn-'))
	try {
		const path = join(cwd, 'doc.md')
		const tools = new ToolRegistry()
		for (const tool of [ReadFileTool, WriteFileTool, EditTool]) tools.register(tool)
		const fileReadTracker = createFileReadTracker()
		const base = {
			tools,
			fileReadTracker,
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			runConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10000, tokenBudget: 100000 },
			sessionId: fixtureId.session('file-observations'),
			topicId: fixtureId.topic('file-observations'),
			projectId: fixtureId.project('file-observations'),
			tenantId: fixtureId.tenant('file-observations'),
		}
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'Create doc.md' }],
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path, content: 'alpha\nbeta\n' } }] },
					{ text: 'created' },
				],
			}),
		})
		expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\n')
		await writeFile(path, 'ALPHA\nbeta\n')
		const second = await drainQuery({
			...base,
			messages: [...first.messages, { role: 'user', content: 'Change beta to gamma' }],
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ id: 'e', name: 'edit', args: { path, old_string: 'beta', new_string: 'gamma' } },
						],
					},
					{ text: 'stopped' },
				],
			}),
		})
		const refusal = second.messages.find((m) => m.role === 'tool' && m.toolCallId === 'e')
		expect(refusal?.content).toContain('changed on disk')
		expect(await readFile(path, 'utf8')).toBe('ALPHA\nbeta\n')
		const third = await drainQuery({
			...base,
			messages: [
				...second.messages,
				{ role: 'user', content: 'Read the current file and apply the change' },
			],
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'r', name: 'read', args: { path } }] },
					{
						toolCalls: [
							{ id: 'e2', name: 'edit', args: { path, old_string: 'beta', new_string: 'gamma' } },
						],
					},
					{ text: 'done' },
				],
			}),
		})
		expect(third.stopReason).toBe('end_turn')
		expect(await readFile(path, 'utf8')).toBe('ALPHA\ngamma\n')
	} finally {
		await removeTempDirs([cwd])
	}
})
