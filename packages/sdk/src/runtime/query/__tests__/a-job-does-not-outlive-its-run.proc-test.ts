import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Run } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'

/**
 * A background job outlives its tool call. It must not outlive its run.
 *
 * Outliving the call is the whole point, which is exactly what makes an
 * unterminated one an orphan: the run ends, the ids go with it, and the
 * process keeps running with nothing left that can name it. The teardown is
 * not a tidy-up — it is the other half of the feature — so these prove the
 * `finally` in `query` actually runs it rather than being a line nobody
 * reaches.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * An async iterable that throws on first pull.
 *
 * Not an `async *` generator: a generator body with no `yield` in it is a
 * lint error, and adding an unreachable one after the throw would be a line
 * written to satisfy a rule rather than to say anything.
 */
const explodes = (): AsyncIterable<never> => ({
	[Symbol.asyncIterator]: () => ({
		next: () => Promise.reject(new Error('provider exploded')),
	}),
})

async function runStartingAJob(
	backgroundJobs: BackgroundJobRegistry,
	command: string,
): Promise<Run | { error: unknown }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-runjobs-'))
	dirs.push(workingDirectory)

	const tools = new ToolRegistry()
	tools.register(BashTool)

	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'call_1',
						name: 'bash',
						args: { command, timeout: 1000, run_in_background: true },
					},
				],
			},
			{ text: 'started' },
		] as never,
	})

	return await drainQuery({
		provider,
		tools,
		runConfig: { model: 'mock', timeoutMs: 30_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('start the watcher')],
		workingDirectory,
		sessionId: 'ses_jobs' as SessionId,
		topicId: 'top_jobs' as TopicId,
		projectId: 'prj_jobs' as ProjectId,
		tenantId: 'tnt_jobs' as TenantId,
		backgroundJobs,
	}).catch((error: unknown) => ({ error }) as { error: unknown })
}

describe('a run takes its background jobs with it', () => {
	it('leaves nothing of its own running', async () => {
		const registry = new BackgroundJobRegistry()

		const run = (await runStartingAJob(registry, 'sleep 30')) as Run

		// Nothing is left under this run's id — and the id is real, so a
		// vacuously-empty list is not what is being asserted.
		expect(run.id).toBeTruthy()
		const mine = registry.list(run.id)
		expect(mine.length).toBeGreaterThan(0)
		expect(mine.every((job) => job.status === 'killed')).toBe(true)
	})

	it('reaches what the job itself forked, not only the shell', async () => {
		// The grandchild is the one that survives a naive `child.kill()`, and
		// it is the one that keeps holding a port or a file lock.
		const registry = new BackgroundJobRegistry()

		const run = (await runStartingAJob(registry, 'sleep 30 & echo $!; wait')) as Run
		const job = registry.list(run.id)[0]
		if (!job) throw new Error('the run started no job')
		const printed = registry.read(job.id).chunk.trim().split('\n')[0]
		const grandchild = Number(printed)

		expect(Number.isFinite(grandchild)).toBe(true)
		await settle(300)
		expect(alive(grandchild)).toBe(false)
	})

	it('kills them on a FAILED run too', async () => {
		// The `finally`, not the happy path. A run that threw has the same
		// orphan problem and more reason to have started something slow.
		const registry = new BackgroundJobRegistry()
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-runjobs-fail-'))
		dirs.push(workingDirectory)
		const tools = new ToolRegistry()
		tools.register(BashTool)

		// One good turn that starts the job, then a provider that explodes.
		let turn = 0
		class FirstThenExplode extends MockLLMProvider {
			override chatStream(params: never) {
				turn += 1
				if (turn === 1) return super.chatStream(params)
				return explodes()
			}
		}

		const outcome = await drainQuery({
			provider: new FirstThenExplode({
				turns: [
					{
						toolCalls: [
							{
								id: 'call_1',
								name: 'bash',
								args: { command: 'sleep 30', timeout: 1000, run_in_background: true },
							},
						],
					},
				] as never,
			}),
			tools,
			runConfig: { model: 'mock', timeoutMs: 30_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('start the watcher')],
			workingDirectory,
			sessionId: 'ses_jobs_fail' as SessionId,
			topicId: 'top_jobs' as TopicId,
			projectId: 'prj_jobs' as ProjectId,
			tenantId: 'tnt_jobs' as TenantId,
			backgroundJobs: registry,
		}).catch((error: unknown) => ({ error }) as { error: unknown })

		// The run must actually have failed, or this asserts the happy path
		// under a name that says otherwise.
		const failed = 'error' in outcome || outcome.status !== 'completed'
		expect(failed).toBe(true)

		const runId = 'error' in outcome ? undefined : outcome.id
		if (!runId) throw new Error('no run id to check')
		const mine = registry.list(runId)
		expect(mine.length).toBeGreaterThan(0)
		expect(mine.every((job) => job.status === 'killed')).toBe(true)
	})

	it('leaves another owner’s jobs alone', async () => {
		// Teardown is scoped to the run's id. A shared registry serving
		// several runs must not have one of them tear down another's work.
		const registry = new BackgroundJobRegistry()
		const theirs = registry.start({
			owner: 'run_elsewhere',
			command: 'sleep 30',
			workingDirectory: tmpdir(),
		})

		await runStartingAJob(registry, 'sleep 30')

		expect(registry.get(theirs.id).status).toBe('running')
		await registry.kill(theirs.id)
	})
})
