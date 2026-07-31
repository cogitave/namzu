import { readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { EditTool, WriteFileTool } from '../../../tools/builtins/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

interface ToolStep {
	readonly name: string
	readonly input: Record<string, unknown>
}

/**
 * Script the steps, then a closing text turn.
 *
 * This replaces a hand-rolled provider that never emitted `toolCallEnd`
 * and relied on end-of-stream inference to close each tool block. The
 * mock emits that boundary the way a real driver does (Anthropic's
 * `content_block_stop`), so the collapse raises fidelity rather than
 * merely removing code.
 */
function scriptedLongDocumentProvider(steps: readonly ToolStep[]): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			...steps.map((step) => ({ toolCalls: [{ name: step.name, args: step.input }] })),
			{ text: 'Long document created and verified.' },
		],
	})
}

describe('query long-document tool flow', () => {
	const workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
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

		const provider = scriptedLongDocumentProvider([
			{
				name: 'write',
				input: {
					path: 'outputs/long-document-flow.md',
					content: '# Long document flow\n\n{{BODY}}\n',
				},
			},
			{
				name: 'edit',
				input: {
					path: 'outputs/long-document-flow.md',
					oldStr: '{{BODY}}',
					newStr: chunks[0],
					replace_all: false,
				},
			},
			...chunks.slice(1).map((chunk) => ({
				name: 'edit',
				input: {
					path: 'outputs/long-document-flow.md',
					insertLine: 'end',
					newStr: chunk,
					replace_all: false,
				},
			})),
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
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 8,
					maxResponseTokens: 256,
				},
				agentId: 'agent_long_doc',
				agentName: 'Long Document Agent',
				messages: [createUserMessage('create a long document')],
				workingDirectory,
				sessionId: 'ses_long_document_flow' as SessionId,
				threadId: 'thd_long_document_flow' as ThreadId,
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
		// One request per turn — the mock records every one it received.
		expect(provider.requests).toHaveLength(6)
		expect(executingTools).toEqual(['write', 'edit', 'edit', 'edit', 'edit'])
		expect(final).not.toContain('{{BODY}}')
		expect(final.split('\n').length).toBeGreaterThan(160)
		expect(final).toContain('## Section 1')
		expect(final).toContain('## Section 4')
		expect(final).toContain('Section 4.40')
	})
})
