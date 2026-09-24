import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { createUserMessage } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'
import { heldCheckpointStore, memorySession, turnCheckpoints } from './support/session.js'

/**
 * A checkpoint outlives the turn it describes: nothing prunes it merely
 * because the turn went on to finish (`turn_completed`) or die
 * (`turn_failed`). `assertTurnMayStart` (`prepare-turn.ts`) already refused
 * this deep inside `query()`, after claiming a lease under the dead turn's
 * id and resolving its storage, with a message written for whoever reads
 * `query()`'s own errors ("… is not the active turn of session …; a settled
 * turn cannot be resumed").
 *
 * `resumeSession` is the public entry point every resume actually goes
 * through — the TUI, `exec --resume`'s parked-turn continuation and
 * scheduled-run resume all call it — and nothing in IT enforced the same
 * rule before reaching that deep. This checks it there too: cheaper (no
 * lease claimed and released for nothing) and with a message written for a
 * resume caller specifically, one step before the same conversation-safety
 * property `query()` already held.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-completed-checkpoint-'))
	dirs.push(cwd)
	await writeFile(join(cwd, 'notes.txt'), 'placeholder file body\n')
	return cwd
}

describe('resumeSession refuses a completed turns checkpoint', () => {
	it('throws instead of restarting a turn the log already closed', async () => {
		const cwd = await workingTree()
		const session = memorySession()
		const tools = new ToolRegistry()
		tools.register(ReadFileTool)

		const turn = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
					{ text: 'placeholder final answer' },
				],
			}),
			tools,
			messages: [createUserMessage('placeholder message')],
			workingDirectory: cwd,
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 },
			agentId: 'completed-checkpoint',
			agentName: 'Completed checkpoint',
			...session,
		})
		expect(turn.status).toBe('completed')

		const checkpoints = await turnCheckpoints({ ...session, turnId: turn.id })
		expect(checkpoints.length).toBeGreaterThan(0)
		const checkpointId = checkpoints.at(-1)?.checkpointId
		if (!checkpointId) throw new Error('the completed turn left no checkpoint to try resuming')

		await expect(
			resumeSession({
				provider: new MockLLMProvider({ responseText: 'must not run' }),
				tools: new ToolRegistry(),
				scope: { ...session, turnId: turn.id },
				checkpointStore: await heldCheckpointStore(session.sessionLog),
				checkpointId,
				resumeHandler: autoApproveHandler,
				turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 },
				agentId: 'completed-checkpoint',
				agentName: 'Completed checkpoint',
				...session,
			}),
		).rejects.toMatchObject({
			code: 'invalid_config',
			message: expect.stringContaining('already ended'),
		})
	})
})
