import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../session/workspace/path-builder.js'
import { InMemoryCheckpointStore } from '../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../store/run/memory.js'
import { getBuiltinTools } from '../../tools/builtins/index.js'
import { runAgent } from '../runAgent.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
	'keeps run state outside the tool workspace (injected stores: %s)',
	async (memory) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-entry-storage-'))
		roots.push(root)
		const cwd = join(root, 'workspace')
		await mkdir(cwd)
		await writeFile(join(cwd, 'note.txt'), 'Current source.')
		const tools = new ToolRegistry()
		tools.register(getBuiltinTools().filter((t) => t.name === 'read'))
		const pathBuilder = new DefaultPathBuilder(join(root, 'private-state'))
		const runStore = memory ? new InMemoryRunStore() : undefined
		const checkpointStore = memory ? new InMemoryCheckpointStore() : undefined
		const result = await runAgent({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
					{ text: 'Read the current source.' },
				],
			}),
			model: 'mock-model',
			prompt: 'Read note.txt',
			workingDirectory: cwd,
			tools,
			pathBuilder,
			runStore,
			checkpointStore,
		})
		expect(result.output).toBe('Read the current source.')
		expect(JSON.stringify(result.run.messages)).toContain('Current source.')
		expect(await readdir(cwd)).toEqual(['note.txt'])
		if (runStore && checkpointStore) {
			const snapshot = await runStore.readMessages()
			if (!('messages' in snapshot)) throw new Error('Expected retained messages.')
			expect(JSON.stringify(snapshot.messages)).toContain('Current source.')
			const checkpoints = await checkpointStore.listCheckpoints({
				...result.identity,
				runId: result.run.id,
			})
			expect(checkpoints.length).toBeGreaterThan(0)
		} else {
			const dir = pathBuilder.runDir(
				result.identity.projectId,
				result.identity.sessionId,
				result.run.id,
			)
			const files = await readdir(dir)
			expect(files).toContain('transcript.jsonl')
			expect(await readFile(join(dir, 'transcript.jsonl'), 'utf8')).toContain('Current source.')
		}
	},
)
