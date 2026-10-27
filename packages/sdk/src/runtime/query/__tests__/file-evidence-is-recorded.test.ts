import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { fileEvidenceEntries, heldFileEvidence } from '../../../test-support/file-evidence-held.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

/**
 * What the loop learns about files is recorded in the conversation as the
 * difference from what the conversation already says: nothing while nothing
 * changed, the entry that changed when one did, and a line naming a path
 * whose earlier entry no longer holds when it stops being true. An earlier
 * entry is never edited, so each request begins with the one before it.
 */

const shape = (messages: readonly Message[]) =>
	messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`)

function params(cwd: string, name: string) {
	return {
		toolsets: [testToolset(WriteFileTool, EditTool)],
		fileReadTracker: createFileReadTracker(),
		agentId: 'test',
		agentName: 'test',
		workingDirectory: cwd,
		turnConfig: { model: 'mock', maxIterations: 8, timeoutMs: 10_000, tokenBudget: 100_000 },
		sessionId: fixtureId.session(name),
		topicId: fixtureId.topic(name),
		projectId: fixtureId.project(name),
		tenantId: fixtureId.tenant(name),
	}
}

it('records an entry when a file is written, a delta when it is edited, and nothing between', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-file-record-'))
	try {
		const a = join(cwd, 'a.md')
		const b = join(cwd, 'b.md')
		const requests: Message[][] = []
		const run = await drainQuery({
			...params(cwd, 'file-record'),
			messages: [{ role: 'user', content: 'Write two files and refine the first' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'wa', name: 'write', args: { path: a, content: 'one\n' } }] },
					{ toolCalls: [{ id: 'wb', name: 'write', args: { path: b, content: 'two\n' } }] },
					{
						toolCalls: [
							{ id: 'ea', name: 'edit', args: { path: a, old_string: 'one', new_string: 'uno' } },
						],
					},
					{ text: 'done' },
				],
			}),
		})

		const recorded = fileEvidenceEntries(run.messages)
		// One record per change (a written, b written, a edited), not per call.
		expect(recorded).toHaveLength(3)
		expect(recorded[0]).toContain('each entry')
		expect(recorded[1]).not.toContain('each entry')
		// The second names only b; the third only a, with its edit.
		expect(recorded[1]).toContain('"bodyInCall":"wb"')
		expect(recorded[1]).not.toContain('"bodyInCall":"wa"')
		expect(recorded[2]).toContain('"editsInCalls":["ea"]')
		expect(recorded[2]).not.toContain('"bodyInCall":"wb"')
		expect(heldFileEvidence(run.messages)).toHaveLength(2)

		// Every request begins with the whole of the one before it.
		for (const [i, request] of requests.entries()) {
			if (i === 0) continue
			const before = shape(requests[i - 1] as Message[])
			expect(shape(request).slice(0, before.length)).toEqual(before)
		}
	} finally {
		await removeTempDirs([cwd])
	}
})

it('names a path whose entry stopped holding because its receipt was cleared from the history', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-file-record-stale-'))
	try {
		const path = join(cwd, 'note.md')
		const base = params(cwd, 'file-record-stale')
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'Write note.md' }],
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path, content: 'body\n' } }] },
					{ text: 'written' },
				],
			}),
		})
		expect(heldFileEvidence(first.messages)).toHaveLength(1)

		// The receipt the entry points at is cleared, as a compaction would do.
		const cleared = first.messages.map((m) =>
			m.role === 'tool' && m.toolCallId === 'w'
				? clearToolResult(m as ToolMessage, 'write').message
				: m,
		)
		const requests: Message[][] = []
		const second = await drainQuery({
			...base,
			// A history edited on purpose is a new conversation to the session log.
			sessionId: fixtureId.session('file-record-stale-edited'),
			messages: [
				...cleared.map(({ id: _id, ...rest }) => rest as Message),
				{ role: 'user', content: 'What next?' },
			],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [{ text: 'nothing' }],
			}),
		})
		// The entry stays where it was; a later one says it no longer holds.
		const recorded = fileEvidenceEntries(second.messages)
		expect(recorded).toHaveLength(2)
		expect(recorded[1]).toContain(`No longer holds: ${JSON.stringify([path])}`)
		expect(heldFileEvidence(requests[0])).toBeUndefined()
		// And a third request has nothing more to say.
		expect(fileEvidenceEntries(second.messages)).toEqual(recorded)
	} finally {
		await removeTempDirs([cwd])
	}
})
