import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import { drainQuery } from '../index.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots)
	roots.length = 0
})

it.each(['enabled', 'opt-out', 'disabled', 'unconfigured'] as const)(
	'runs real observations and preserves externally changed content with policy %s',
	async (mode) => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-observation-policy-'))
		roots.push(cwd)
		const path = join(cwd, 'file.txt')
		const initial = 'original line with exact file evidence\n'.repeat(200)
		const changed = `${initial}EXTERNAL CHANGE\n`
		await writeFile(path, initial)
		let reads = 0
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'observe_file',
				description: 'Read the file',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					reads++
					return { success: true, output: await readFile(path, 'utf8') }
				},
			}),
		)
		const delegate = new MockLLMProvider({
			turns: [
				...['a', 'b', 'c'].map((id) => ({ toolCalls: [{ id, name: 'observe_file', args: {} }] })),
				{ text: 'done' },
			],
		})
		let requests = 0
		const provider: LLMProvider = {
			id: delegate.id,
			name: delegate.name,
			capabilities: delegate.capabilities,
			async *chatStream(params) {
				requests++
				// Another actor changes the file after the second observation.
				if (requests === 3) await writeFile(path, changed)
				yield* delegate.chatStream(params)
			},
		}
		const result = await drainQuery({
			provider,
			repeatCallAdvisory: false,
			tools,
			agentId: 'context-test',
			agentName: 'Context test',
			messages: [{ role: 'user', content: 'Observe the file three times' }],
			workingDirectory: cwd,
			runConfig: { model: 'mock', timeoutMs: 20000, tokenBudget: 100000, maxIterations: 4 },
			...(mode === 'unconfigured'
				? {}
				: {
						compactionConfig: CompactionConfigSchema.parse({
							strategy: mode === 'disabled' ? 'disabled' : 'salience',
							...(mode === 'opt-out' ? { deduplicateObservations: false } : {}),
							contextWindowTokens: 1000000,
						}),
					}),
			sessionId: fixtureId.session('observation-context'),
			topicId: fixtureId.topic('observation-context'),
			projectId: fixtureId.project('observation-context'),
			tenantId: fixtureId.tenant('observation-context'),
		})
		expect(reads).toBe(3)
		expect(requests).toBe(4)
		const sent = delegate.requests[3]!.messages.filter((m) => m.role === 'tool')
		expect(sent).toHaveLength(3)
		if (mode === 'enabled') {
			expect(sent[1]?.content).toContain('Duplicate observation')
			expect(sent[1]?.content).toContain('"a"')
		} else expect(sent[1]?.content).toBe(initial)
		expect(sent[0]?.content).toBe(initial)
		expect(sent[2]?.content).toBe(changed)
		expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
			initial,
			initial,
			changed,
		])
	},
)
