import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'

/**
 * What a finished run leaves on disk, read back the way a host reads it.
 *
 * The cancelled path is read back in `cancelled-provider-receipts.test.ts`,
 * and the resume paths read their own checkpoints. A plain SUCCESSFUL run
 * read back through its own store had no test at all, and it is the ordinary
 * case: the meta row, the report a person opens and the transcript are
 * written by three separate calls on the way out, and nothing asserted they
 * agreed with each other or with the `Run` that was returned.
 *
 * The budget agreement belongs with them. `Run.budget` and
 * `run_completed.budget` are the same projection taken at two moments, and a
 * host reading the number off the event and the number off the returned run
 * has to get one answer.
 */

const ANSWER = 'the release is ready'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function echoRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
	return tools
}

async function dirWith(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

async function runToCompletion(): Promise<{
	run: Run
	events: RunEvent[]
	store: RunDiskStore
	runDir: string
}> {
	const store = new RunDiskStore({ baseDir: await dirWith('namzu-readback-') })
	const events: RunEvent[] = []

	const run = await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }],
						finishReason: 'tool_calls',
					},
					{ text: ANSWER, usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 } },
				],
			}),
			tools: echoRegistry(),
			runStore: store,
			agentId: 'agent_readback',
			agentName: 'Readback agent',
			messages: [{ role: 'user', content: 'check the release' }],
			workingDirectory: await dirWith('namzu-readback-work-'),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			resumeHandler: autoApproveHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)

	const runDir = store.getRunDir()
	if (!runDir) throw new Error('the disk store bound no run directory')
	return { run, events, store, runDir }
}

describe('a successful run read back from its store', () => {
	it('leaves meta saying the run completed, under the id it was returned with', async () => {
		const { run, runDir } = await runToCompletion()

		const meta = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as Record<
			string,
			unknown
		>
		expect(meta.id).toBe(run.id)
		expect(meta.status).toBe('completed')
		expect(meta.endedAt).toBeGreaterThan(0)
		expect(meta.messageCount).toBe(run.messages.length)
		expect(meta.budget).toEqual(run.budget)
	})

	it('does NOT put the answer or the stop reason in meta', async () => {
		// PINNED CURRENT (DEFECTIVE) BEHAVIOUR, and the reason this file
		// exists at all. `writeRunMeta` builds its row from `id`, `status`,
		// `metadata`, `tokenUsage`, `budget`, `budgetBinding`,
		// `currentIteration`, `startedAt`, `endedAt`, `lastError` and
		// `messageCount` — and neither `result` nor `stopReason` is among
		// them. A host that reloads a run from `run.json` gets a row that says
		// `completed` and cannot say what was completed, nor tell a run that
		// answered from one that hit its budget; the only durable copy of the
		// answer is `report.md`, which is written from the same field.
		//
		// The source comment beside the `structuredOutput` line reads "for the
		// same reason `result` does", which describes a write that is not
		// there. Reported for a fix on its own track; the refactor must not
		// change this in either direction.
		const { run, runDir } = await runToCompletion()

		const meta = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as Record<
			string,
			unknown
		>
		expect(run.result).toBe(ANSWER)
		expect(run.stopReason).toBe('end_turn')
		expect('result' in meta).toBe(false)
		expect('stopReason' in meta).toBe(false)
	})

	it('opens as a report holding exactly the answer', async () => {
		const { run, runDir } = await runToCompletion()

		// The report is the file a person opens. It is written only when the
		// run produced a result, and it carries that result verbatim rather
		// than the metadata around it.
		expect(await readFile(join(runDir, 'report.md'), 'utf8')).toBe(ANSWER)
		expect(run.result).toBe(ANSWER)
	})

	it('keeps a transcript whose tool results answer their own calls', async () => {
		const { store } = await runToCompletion()

		// Read through the store's own reader rather than the file, so this is
		// the transcript a host gets and not a JSON shape that happens to
		// match.
		const snapshot = await store.readMessages()
		// The reader says WHICH kind of record it is holding rather than
		// handing back a bare array, so a caller can tell a verified snapshot
		// from a legacy one and from a store that does not persist messages at
		// all. A run that just finished must be the verified kind.
		expect(snapshot.kind).toBe('available')
		if (snapshot.kind !== 'available') return
		expect(snapshot.messages.map((message) => message.role)).toEqual([
			'system',
			'system',
			'user',
			'assistant',
			'tool',
			'assistant',
		])
		expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', content: ANSWER })
		// The snapshot records the sequence it was taken through, which is
		// what makes it a snapshot rather than a guess.
		expect(snapshot.throughEventSeq).toBeGreaterThan(0)
	})
})

describe('the budget a finished run reports', () => {
	it('is the same number on the event and on the run it returned', async () => {
		const { run, events } = await runToCompletion()

		const completed = events.find(
			(event): event is Extract<RunEvent, { type: 'run_completed' }> =>
				event.type === 'run_completed',
		)
		expect(completed).toBeDefined()
		// Asserted for AGREEMENT, which is the claim: the event is what a
		// streaming host reads and the `Run` is what an awaiting one reads,
		// and two projections of one budget that disagree leave neither reader
		// able to say what the run cost.
		expect(completed?.budget).toEqual(run.budget)
		// And it is populated rather than absent, so the agreement above is
		// not two `undefined`s meeting.
		expect(completed?.budget).toBeDefined()
		expect(completed?.budget?.limit).toBe(100_000)
	})
})
