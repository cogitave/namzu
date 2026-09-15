import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
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
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

/**
 * The claim a read entry makes is about the RECEIPT, so nothing short of the
 * whole path can prove it: the tool fingerprints what it returns, the executor
 * carries that string onto the `ToolMessage` untouched, and the projection
 * fingerprints the receipt it finds in the next request. A test that built the
 * receipt by hand would be asserting its own arithmetic.
 */

/** The JSON payload of a request's file-evidence message, if it carries one. */
function entriesIn(messages: Message[] | undefined): unknown {
	const content = String(messages?.at(-1)?.content ?? '')
	if (!content.includes('Visible file evidence')) return undefined
	return JSON.parse(content.split('\n').at(-1) as string)
}

it('carries a whole-file read into the next turn, and withdraws it when the file moves underneath', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-read-evidence-'))
	try {
		const path = join(cwd, 'doc.md')
		await writeFile(path, 'alpha\nbeta\n')
		const tools = new ToolRegistry()
		for (const tool of [ReadFileTool, EditTool]) tools.register(tool)
		const fileReadTracker = createFileReadTracker()
		const base = {
			tools,
			fileReadTracker,
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			runConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10000, tokenBudget: 100000 },
			sessionId: fixtureId.session('read-evidence'),
			topicId: fixtureId.topic('read-evidence'),
			projectId: fixtureId.project('read-evidence'),
			tenantId: fixtureId.tenant('read-evidence'),
		}
		const requests: Message[][] = []
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'Read doc.md' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [{ toolCalls: [{ id: 'r', name: 'read', args: { path } }] }, { text: 'read it' }],
			}),
		})
		expect(entriesIn(requests[0])).toBeUndefined()
		expect(entriesIn(requests[1])).toEqual([
			{ path, kind: 'read', bodyInCall: 'r', observedFingerprint: expect.any(String) },
		])
		// The body is referenced, not copied: it is already in the request, in
		// the receipt the entry names.
		expect(String(requests[1]?.at(-1)?.content)).not.toContain('alpha')
		// And the entry's claim about that receipt, asserted against the very
		// array the provider was handed: still byte-for-byte what the tool
		// fingerprinted, so a later stage that decorated a tool result after the
		// projection ran would fail here rather than pass silently.
		const receipt = requests[1]?.find((m) => m.role === 'tool' && m.toolCallId === 'r')
		expect(fingerprintContent(String(receipt?.content))).toBe(
			fileReadTracker.readWitness?.(await realpath(path))?.renderedFingerprint,
		)
		expect(first.messages.some((m) => String(m.content).includes('Visible file evidence'))).toBe(
			false,
		)

		// Someone else writes between the turns. The ledger does not know yet,
		// and the projection is not going to find out by reading the disk.
		await writeFile(path, 'ALPHA\nbeta\n')
		const afterDrift: Message[][] = []
		const second = await drainQuery({
			...base,
			messages: [...first.messages, { role: 'user', content: 'Change beta to gamma' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => afterDrift.push([...messages]),
				turns: [
					{
						toolCalls: [
							{ id: 'e', name: 'edit', args: { path, old_string: 'beta', new_string: 'gamma' } },
						],
					},
					{ toolCalls: [{ id: 'r2', name: 'read', args: { path } }] },
					{ text: 'replanned' },
				],
			}),
		})
		expect(entriesIn(afterDrift[0])).toEqual([
			{ path, kind: 'read', bodyInCall: 'r', observedFingerprint: expect.any(String) },
		])
		// Admission is what finds out, and its refusal is what tells the ledger.
		const refusal = second.messages.find((m) => m.role === 'tool' && m.toolCallId === 'e')
		expect(refusal?.content).toContain('changed on disk')
		expect(await readFile(path, 'utf8')).toBe('ALPHA\nbeta\n')
		expect(entriesIn(afterDrift[1])).toBeUndefined()
		// Reading again re-baselines the ledger, and the entry comes back naming
		// the call whose receipt shows what is there now.
		expect(entriesIn(afterDrift[2])).toEqual([
			{ path, kind: 'read', bodyInCall: 'r2', observedFingerprint: expect.any(String) },
		])
	} finally {
		await removeTempDirs([cwd])
	}
})

it('withholds a windowed read, which shows a fragment however large the window is', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-read-window-'))
	try {
		const path = join(cwd, 'doc.md')
		await writeFile(path, 'alpha\nbeta\ngamma\n')
		const tools = new ToolRegistry()
		tools.register(ReadFileTool)
		const requests: Message[][] = []
		await drainQuery({
			tools,
			fileReadTracker: createFileReadTracker(),
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			runConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10000, tokenBudget: 100000 },
			sessionId: fixtureId.session('read-window'),
			topicId: fixtureId.topic('read-window'),
			projectId: fixtureId.project('read-window'),
			tenantId: fixtureId.tenant('read-window'),
			messages: [{ role: 'user', content: 'Read the first two lines' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'r', name: 'read', args: { path, readRange: [1, 2] } }] },
					{ text: 'read it' },
				],
			}),
		})
		expect(entriesIn(requests[1])).toBeUndefined()
	} finally {
		await removeTempDirs([cwd])
	}
})
