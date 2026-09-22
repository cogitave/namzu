import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

it('carries a wrapped successful write across query turns and refuses an edit after external drift', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cross-turn-'))
	try {
		const path = join(cwd, 'doc.md')
		const tools = new ToolRegistry()
		for (const tool of [ReadFileTool, EditTool]) tools.register(tool)
		// CLI checkpoint wrappers retain context but replace execute's function identity.
		const wrappedWrite: typeof WriteFileTool = {
			...WriteFileTool,
			execute: async (input, context) => WriteFileTool.execute(input, context),
		}
		tools.register(wrappedWrite)
		const fileReadTracker = createFileReadTracker()
		const requests: Message[][] = []
		const base = {
			tools,
			fileReadTracker,
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			turnConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10000, tokenBudget: 100000 },
			sessionId: fixtureId.session('file-observations'),
			topicId: fixtureId.topic('file-observations'),
			projectId: fixtureId.project('file-observations'),
			tenantId: fixtureId.tenant('file-observations'),
		}
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'Create doc.md' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path, content: 'alpha\nbeta\n' } }] },
					{ text: 'created' },
				],
			}),
		})
		expect(requests[0]?.some((m) => String(m.content).includes('Visible file evidence'))).toBe(
			false,
		)
		expect(requests[1]?.at(-1)?.content).toContain('"bodyInCall":"w"')
		expect(first.messages.some((m) => String(m.content).includes('Visible file evidence'))).toBe(
			false,
		)
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

/** The JSON payload of a request's file-evidence message, if it carries one. */
function entriesIn(messages: Message[] | undefined): unknown {
	const content = String(messages?.at(-1)?.content ?? '')
	if (!content.includes('Visible file evidence')) return undefined
	return JSON.parse(content.split('\n').at(-1) as string)
}

it('carries a write and the edits on top of it into the next turn, and withdraws the path when a mutation is refused for drift', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cross-turn-chain-'))
	try {
		const path = join(cwd, 'doc.md')
		const tools = new ToolRegistry()
		for (const tool of [ReadFileTool, EditTool, WriteFileTool]) tools.register(tool)
		const fileReadTracker = createFileReadTracker()
		const requests: Message[][] = []
		const base = {
			tools,
			fileReadTracker,
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			turnConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10000, tokenBudget: 100000 },
			sessionId: fixtureId.session('file-chain'),
			topicId: fixtureId.topic('file-chain'),
			projectId: fixtureId.project('file-chain'),
			tenantId: fixtureId.tenant('file-chain'),
		}
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'Create doc.md and fix the second line' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path, content: 'alpha\nbeta\n' } }] },
					{
						toolCalls: [
							{ id: 'e', name: 'edit', args: { path, old_string: 'beta', new_string: 'gamma' } },
						],
					},
					{ text: 'done' },
				],
			}),
		})
		expect(await readFile(path, 'utf8')).toBe('alpha\ngamma\n')
		// The write alone, then the write plus the edit that has since moved it.
		expect(entriesIn(requests[1])).toEqual([
			{ path, bodyInCall: 'w', observedFingerprint: expect.any(String) },
		])
		expect(entriesIn(requests[2])).toEqual([
			{ path, bodyInCall: 'w', editsInCalls: ['e'], observedFingerprint: expect.any(String) },
		])
		expect(String(requests[2]?.at(-1)?.content)).not.toContain('gamma')
		expect(first.messages.some((m) => String(m.content).includes('Visible file evidence'))).toBe(
			false,
		)
		// Someone else writes between the turns. The ledger does not know yet,
		// and the projection is not going to find out by reading the disk —
		// admission is, and the refusal it returns is what tells the ledger.
		await writeFile(path, 'ALPHA\ngamma\n')
		const requestsAfterDrift: Message[][] = []
		const second = await drainQuery({
			...base,
			messages: [...first.messages, { role: 'user', content: 'Now change alpha to delta' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requestsAfterDrift.push([...messages]),
				turns: [
					{
						toolCalls: [
							{ id: 'e2', name: 'edit', args: { path, old_string: 'alpha', new_string: 'delta' } },
						],
					},
					{ toolCalls: [{ id: 'r', name: 'read', args: { path } }] },
					{ text: 'replanned' },
				],
			}),
		})
		const refusal = second.messages.find((m) => m.role === 'tool' && m.toolCallId === 'e2')
		expect(refusal?.content).toContain('changed on disk')
		expect(await readFile(path, 'utf8')).toBe('ALPHA\ngamma\n')
		// The refused edit read the real file to refuse, so the entry goes with
		// it: the chain still reconstructs a body the model could rebuild, but
		// it is no longer the file's body and the entry claims that it is.
		expect(entriesIn(requestsAfterDrift[1])).toBeUndefined()
		// The model then reads the file, which re-baselines the fingerprint and
		// clears the flag with it. The chain is gone for good — a read roots
		// none — and what comes back is the read's own entry, naming the receipt
		// the current body is visible in.
		expect(entriesIn(requestsAfterDrift[2])).toEqual([
			{ path, kind: 'read', bodyInCall: 'r', observedFingerprint: expect.any(String) },
		])
		expect(fileReadTracker.editChain?.(path)).toBeUndefined()
		expect(fileReadTracker.driftObserved?.(path)).toBe(false)
		expect(fileReadTracker.fingerprint?.(path)).toBe(fingerprintContent('ALPHA\ngamma\n'))
	} finally {
		await removeTempDirs([cwd])
	}
})
