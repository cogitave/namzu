import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { EditTool, WriteFileTool } from '../../../tools/builtins/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

interface ToolStep {
	readonly name: string
	readonly input: Record<string, unknown>
}

class ScriptedLongDocumentProvider implements LLMProvider {
	readonly id = 'scripted-long-document'
	readonly name = 'Scripted Long Document Provider'
	calls = 0

	constructor(private readonly steps: readonly ToolStep[]) {}

	async *chatStream(): AsyncIterable<StreamChunk> {
		const step = this.steps[this.calls]
		this.calls += 1

		if (!step) {
			yield {
				id: 'msg_done',
				delta: { content: 'Long document created and verified.' },
				finishReason: 'stop',
				usage: ZERO_USAGE,
			}
			return
		}

		yield {
			id: `msg_${this.calls}`,
			delta: {
				toolCalls: [
					{
						index: 0,
						id: `toolu_${this.calls}`,
						type: 'function',
						function: { name: step.name },
					},
				],
			},
		}
		yield {
			id: `msg_${this.calls}`,
			delta: {
				toolCalls: [
					{
						index: 0,
						id: `toolu_${this.calls}`,
						function: { arguments: JSON.stringify(step.input) },
					},
				],
			},
		}
		yield {
			id: `msg_${this.calls}`,
			delta: {},
			finishReason: 'tool_calls',
			usage: ZERO_USAGE,
		}
	}
}

describe('query long-document tool flow', () => {
	const workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs.length = 0
	})

	it('executes the canonical write skeleton plus bounded edit chunks flow end to end', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-query-long-doc-'))
		workdirs.push(workingDirectory)

		const chunks = Array.from({ length: 4 }, (_, sectionIndex) => {
			const lines = Array.from({ length: 40 }, (_, lineIndex) => {
				return `Section ${sectionIndex + 1}.${lineIndex + 1}: this content is intentionally long enough to require repeated bounded edit calls.`
			})
			const chunk = [`## Section ${sectionIndex + 1}`, ...lines, ''].join('\n')
			expect(chunk.length).toBeLessThan(12_000)
			return chunk
		})

		const provider = new ScriptedLongDocumentProvider([
			{
				name: 'write',
				input: {
					path: 'outputs/long-document-flow.md',
					content: '# Long document flow\n\n{{CHUNK_001}}\n',
				},
			},
			...chunks.map((chunk, index) => ({
				name: 'edit',
				input: {
					path: 'outputs/long-document-flow.md',
					old_string: `{{CHUNK_${String(index + 1).padStart(3, '0')}}}`,
					new_string: `${chunk}\n{{CHUNK_${String(index + 2).padStart(3, '0')}}}`,
					replace_all: false,
				},
			})),
			{
				name: 'edit',
				input: {
					path: 'outputs/long-document-flow.md',
					old_string: `{{CHUNK_${String(chunks.length + 1).padStart(3, '0')}}}`,
					new_string: '',
					replace_all: false,
				},
			},
		])
		const tools = new ToolRegistry()
		tools.register(WriteFileTool)
		tools.register(EditTool)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider,
				tools,
				runConfig: {
					model: 'mock-model',
					// The RUN's own deadline, not the test's. This test asserts a
					// flow, never a latency, so the deadline must sit far above
					// the work: six model turns and five file edits take ~3s
					// alone and longer under a parallel suite. The outer vitest
					// timeout was raised for exactly that reason and this one was
					// missed, so the run kept aborting itself at 5s and the
					// failure read as a broken flow rather than a slow machine.
					timeoutMs: 120_000,
					tokenBudget: 100_000,
					maxIterations: 8,
					maxResponseTokens: 256,
				},
				agentId: 'agent_long_doc',
				agentName: 'Long Document Agent',
				messages: [createUserMessage('create a long document')],
				workingDirectory,
				sessionId: 'ses_long_document_flow' as SessionId,
				topicId: 'top_long_document_flow' as TopicId,
				projectId: 'prj_long_document_flow' as ProjectId,
				tenantId: 'tnt_long_document_flow' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		const final = await readFile(join(workingDirectory, 'outputs/long-document-flow.md'), 'utf-8')
		const executingTools = events
			.filter(
				(event): event is Extract<RunEvent, { type: 'tool_executing' }> =>
					event.type === 'tool_executing',
			)
			.map((event) => event.toolName)

		expect(run.status).toBe('completed')
		expect(run.result).toBe('Long document created and verified.')
		expect(provider.calls).toBe(7)
		expect(executingTools).toEqual(['write', 'edit', 'edit', 'edit', 'edit', 'edit'])
		expect(final).not.toContain('{{CHUNK_')
		expect(final.split('\n').length).toBeGreaterThan(160)
		expect(final).toContain('## Section 1')
		expect(final).toContain('## Section 4')
		expect(final).toContain('Section 4.40')
	}, 60_000)
})
