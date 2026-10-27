import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { stubTaskScheduler } from '../../../__fixtures__/task-scheduler.js'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { heldFileEvidence } from '../../../test-support/file-evidence-held.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { TaskHandle } from '../../../types/agent/scheduler.js'
import type { Message } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

/**
 * Two derived contributions compete for the same room, and one of them
 * grows: an edit chain adds a call id per hop to the file-evidence record.
 * The gates in `workContext` are what keep that growth from being paid for by
 * the other contribution, or by the task itself. Each is recorded whole or not
 * at all.
 */

/** One turn that writes a file, edits it `hops` times, then answers. */
async function run(
	window: number,
	hops: number,
): Promise<{ owned: boolean; evidence: { editsInCalls?: string[] } | undefined }> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-work-context-'))
	try {
		const path = join(cwd, 'doc.md')
		const tools = testToolset(WriteFileTool, EditTool)
		// Sixteen, the most the inbox reports, so owned work is the larger of the
		// two contributions and the room genuinely runs out between them.
		const taskIds = Array.from({ length: 16 }, (_, index) =>
			fixtureId.task(`work-context-${index}`),
		)
		const inbox = new CompletionInbox()
		inbox.attach(
			stubTaskScheduler({
				getTask: (taskId) =>
					({
						taskId,
						agentId: 'reader',
						state: 'completed',
						createdAt: 1,
						result: { status: 'completed', stopReason: 'end_turn', result: 'Ece' },
					}) as TaskHandle,
				onTaskCompleted: () => () => {},
			}),
		)
		for (const taskId of taskIds) {
			inbox.launched(taskId)
			inbox.claim(taskId)
		}
		const requests: Message[][] = []
		await drainQuery({
			toolsets: [tools],
			completionInbox: inbox,
			fileReadTracker: createFileReadTracker(),
			agentId: 'test',
			agentName: 'test',
			workingDirectory: cwd,
			turnConfig: {
				model: 'mock',
				maxIterations: hops + 3,
				maxResponseTokens: 100,
				timeoutMs: 10_000,
				tokenBudget: 100_000,
			},
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'disabled',
				contextWindowTokens: window,
			}),
			sessionId: fixtureId.session('work-context'),
			topicId: fixtureId.topic('work-context'),
			projectId: fixtureId.project('work-context'),
			tenantId: fixtureId.tenant('work-context'),
			messages: [{ role: 'user', content: 'Write doc.md and refine it.' }],
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path, content: 'satir0\n' } }] },
					...Array.from({ length: hops }, (_, index) => ({
						toolCalls: [
							{
								id: `edit-call-${index + 1}`,
								name: 'edit',
								args: { path, insertLine: 'end', new_string: `satir${index + 1}\n` },
							},
						],
					})),
					{ text: 'done' },
				],
			}),
		})
		inbox.close()
		const last = requests.at(-1) ?? []
		const contents = last.map((message) => String(message.content))
		return {
			owned: contents.some((content) => content.includes('Owned delegated work')),
			evidence: heldFileEvidence(last)?.[0] as { editsInCalls?: string[] } | undefined,
		}
	} finally {
		await removeTempDirs([cwd])
	}
}

/** The chain the record holds for the file. */
function chainIn(evidence: { editsInCalls?: string[] } | undefined): readonly string[] | undefined {
	return evidence?.editsInCalls
}

it('admits each contribution whole, in order, or not at all', async () => {
	// Straddling the point where the room stops holding both. Below it the two
	// gates in `workContext` are what decide, and each contribution is
	// measured on its own size in its own turn.
	const windows = [2_800, 2_900, 3_000, 3_100, 3_200, 3_300, 3_400, 3_600, 4_000, 100_000]
	const seen: {
		window: number
		owned: boolean
		evidence: { editsInCalls?: string[] } | undefined
	}[] = []
	for (const window of windows) seen.push({ window, ...(await run(window, 2)) })

	// Nothing is admitted in halves: what the model reads about the file is
	// the chain as of some call, never a cut-down one, and the latest one it
	// was recorded whole for.
	for (const { evidence } of seen)
		if (evidence !== undefined)
			expect([[], ['edit-call-1'], ['edit-call-1', 'edit-call-2']]).toContainEqual(
				chainIn(evidence) ?? [],
			)
	// Owned work is tried first, so there is room that holds it and not the
	// evidence behind it — and, because a contribution that does not fit is
	// skipped rather than ending the loop, room that holds only the smaller
	// second one. Neither ever arrives cut down to size.
	expect(seen.some((step) => step.owned && step.evidence === undefined)).toBe(true)
	expect(seen.some((step) => !step.owned && step.evidence !== undefined)).toBe(true)
	expect(seen.at(-1)).toMatchObject({ owned: true, evidence: expect.any(Object) })
	expect(chainIn(seen.at(-1)?.evidence)).toEqual(['edit-call-1', 'edit-call-2'])
	expect(seen[0]).toMatchObject({ owned: false, evidence: undefined })
}, 60_000)

it('keeps owned work when a longer chain enlarges the file evidence', async () => {
	const short = await run(100_000, 1)
	const long = await run(100_000, 8)
	expect(chainIn(short.evidence)).toHaveLength(1)
	expect(chainIn(long.evidence)).toHaveLength(8)
	expect(JSON.stringify(long.evidence).length).toBeGreaterThan(
		JSON.stringify(short.evidence).length,
	)
	expect(short.owned).toBe(true)
	expect(long.owned).toBe(true)
}, 60_000)
