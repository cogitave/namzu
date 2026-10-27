import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { fixtureId } from '../../../test-support/ids.js'
import { heldFileEvidence } from '../../../test-support/file-evidence-held.js'
import { testToolset } from '../../../test-support/toolset.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import { type Message, isTurnContextEntry } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

/**
 * The claim a read entry makes is about the RECEIPT, so nothing short of the
 * whole path can prove it: the tool fingerprints what it returns, the executor
 * carries that string onto the `ToolMessage` untouched, and the projection
 * fingerprints the receipt it finds in the next request. A test that built the
 * receipt by hand would be asserting its own arithmetic.
 */

/** The entries the history of a request holds for files. */
const entriesIn = heldFileEvidence

it('carries a whole-file read into the next turn, and withdraws it when the file moves underneath', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-read-evidence-'))
	try {
		const path = join(cwd, 'doc.md')
		await writeFile(path, 'alpha\nbeta\n')
		const tools = testToolset(ReadFileTool, EditTool)
		const fileReadTracker = createFileReadTracker()
		const base = {
			toolsets: [tools],
			fileReadTracker,
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			turnConfig: {
				model: 'mock',
				maxIterations: 5,
				timeoutMs: 10000,
				tokenBudget: 100000,
			},
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
			{
				path,
				kind: 'read',
				bodyInCall: 'r',
				observedFingerprint: expect.any(String),
			},
		])
		// The body is referenced, not copied: it is already in the request, in
		// the receipt the entry names.
		const recorded = requests[1]?.filter(isTurnContextEntry) ?? []
		expect(recorded).toHaveLength(1)
		expect(String(recorded[0]?.content)).not.toContain('alpha')
		// And the entry's claim about that receipt, asserted against the very
		// array the provider was handed: still byte-for-byte what the tool
		// fingerprinted, so a later stage that decorated a tool result after the
		// projection ran would fail here rather than pass silently.
		const receipt = requests[1]?.find((m) => m.role === 'tool' && m.toolCallId === 'r')
		expect(fingerprintContent(String(receipt?.content))).toBe(
			fileReadTracker.readWitness?.(await realpath(path))?.renderedFingerprint,
		)
		// The entry is part of the conversation the turn returns, so the next
		// turn finds it where it was and the opening of its request is unchanged.
		expect(first.messages.filter(isTurnContextEntry)).toHaveLength(1)

		// Someone else writes between the turns. The ledger does not know yet,
		// and the projection is not going to find out by reading the disk.
		await writeFile(path, 'alpha\nBETA\n')
		const afterDrift: Message[][] = []
		const second = await drainQuery({
			...base,
			messages: [...first.messages, { role: 'user', content: 'Change beta to gamma' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => afterDrift.push([...messages]),
				turns: [
					{
						toolCalls: [
							{
								id: 'e',
								name: 'edit',
								args: { path, old_string: 'beta', new_string: 'gamma' },
							},
						],
					},
					{ toolCalls: [{ id: 'r2', name: 'read', args: { path } }] },
					{ text: 'replanned' },
				],
			}),
		})
		expect(entriesIn(afterDrift[0])).toEqual([
			{
				path,
				kind: 'read',
				bodyInCall: 'r',
				observedFingerprint: expect.any(String),
			},
		])
		// The earlier entry stays where it was recorded, ahead of the new
		// operator message, so that message does not move what came before it.
		const sent = afterDrift[0] ?? []
		const askedAt = sent.findIndex((m) => m.content === 'Change beta to gamma')
		expect(askedAt).toBeGreaterThan(-1)
		expect(sent.findIndex(isTurnContextEntry)).toBeLessThan(askedAt)
		// Admission is what finds out, and its refusal is what tells the ledger.
		const refusal = second.messages.find((m) => m.role === 'tool' && m.toolCallId === 'e')
		expect(refusal?.content).toContain('changed on disk')
		expect(await readFile(path, 'utf8')).toBe('alpha\nBETA\n')
		expect(entriesIn(afterDrift[1])).toBeUndefined()
		// Reading again re-baselines the ledger, and the entry comes back naming
		// the call whose receipt shows what is there now.
		expect(entriesIn(afterDrift[2])).toEqual([
			{
				path,
				kind: 'read',
				bodyInCall: 'r2',
				observedFingerprint: expect.any(String),
			},
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
		const tools = testToolset(ReadFileTool)
		const requests: Message[][] = []
		await drainQuery({
			toolsets: [tools],
			fileReadTracker: createFileReadTracker(),
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			turnConfig: {
				model: 'mock',
				maxIterations: 5,
				timeoutMs: 10000,
				tokenBudget: 100000,
			},
			sessionId: fixtureId.session('read-window'),
			topicId: fixtureId.topic('read-window'),
			projectId: fixtureId.project('read-window'),
			tenantId: fixtureId.tenant('read-window'),
			messages: [{ role: 'user', content: 'Read the first two lines' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{
						toolCalls: [{ id: 'r', name: 'read', args: { path, readRange: [1, 2] } }],
					},
					{ text: 'read it' },
				],
			}),
		})
		expect(entriesIn(requests[1])).toBeUndefined()
	} finally {
		await removeTempDirs([cwd])
	}
})
