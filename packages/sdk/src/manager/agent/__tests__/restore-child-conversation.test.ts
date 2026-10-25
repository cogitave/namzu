import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MockLLMProvider } from '../../../provider/mock.js'
import { LocalTaskScheduler } from '../../../scheduler/local.js'
import { readChildSessionMeta } from '../child-session.js'
import { harness, required, tenant } from './child-continuation-harness.js'

const profile = { agent: 'worker', model: 'mock' }
const agentFor = (saved: Readonly<Record<string, string>>) => saved.agent

/** A child finished by one process, and a second process over the same saved state. */
async function afterRestart(options: { recordProfile?: boolean } = {}) {
	const first = await harness({ disk: true })
	const gateway = new LocalTaskScheduler(first.manager, first.context())
	const task = await gateway.createTask({
		...first.taskOptions,
		...(options.recordProfile === false ? {} : { continuationProfile: profile }),
	})
	await gateway.waitForTask(task.taskId)
	const childSessionId = required(task.childSessionId)
	const provider = new MockLLMProvider({ turns: [{ text: 'answer after the restart' }] })
	const second = await harness({
		provider,
		restartOf: first,
	})
	return {
		first,
		second,
		provider,
		childSessionId,
		scheduler: new LocalTaskScheduler(second.manager, second.context()),
	}
}

describe('restoring a saved child conversation', () => {
	it('records what a later process needs in the child meta document', async () => {
		const { first, childSessionId } = await afterRestart()
		const paths = required(first.paths)
		const meta = await readChildSessionMeta(
			paths.subagentMeta({ sessionId: first.parent.id, ancestors: [] }, childSessionId),
		)
		expect(meta?.continuation).toEqual({ workspace: 'shared', profile })
		// The document stays valid JSON the way it was written.
		expect(
			JSON.parse(
				await readFile(
					paths.subagentMeta({ sessionId: first.parent.id, ancestors: [] }, childSessionId),
					'utf8',
				),
			),
		).toMatchObject({ continuation: { profile } })
	})

	it('continues a child that finished in an earlier process, with its saved history', async () => {
		const { second, provider, childSessionId, scheduler } = await afterRestart()
		const restored = await scheduler.restoreChild?.({
			childSessionId,
			workingDirectory: '/tmp',
			agentFor,
		})
		expect(restored).toMatchObject({ status: 'restored', agentId: 'worker', profile })

		const resumed = await scheduler.createTask({
			...second.taskOptions,
			prompt: 'follow-up request',
			resumeSessionId: childSessionId,
		})
		const done = await scheduler.waitForTask(resumed.taskId)
		expect(done.result?.lastError).toBeUndefined()
		expect(done.state).toBe('completed')
		expect(done.childSessionId).toBe(childSessionId)
		const sent = JSON.stringify(provider.requests[0]?.messages)
		expect(sent).toContain('original request')
		expect(sent).toContain('follow-up request')
	})

	it('recreates the child session and edge when the store lost them with the process', async () => {
		const { second, provider, childSessionId, scheduler } = await afterRestart()
		for (const edge of await second.store.getChildren(second.parent.id, tenant))
			await second.store.deleteSubSession(edge.id, tenant)
		await second.store.deleteSession(childSessionId, tenant)

		expect(
			await scheduler.restoreChild?.({ childSessionId, workingDirectory: '/tmp', agentFor }),
		).toMatchObject({ status: 'restored' })
		const resumed = await scheduler.createTask({
			...second.taskOptions,
			prompt: 'follow-up request',
			resumeSessionId: childSessionId,
		})
		expect((await scheduler.waitForTask(resumed.taskId)).state).toBe('completed')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('original request')
	})

	it('refuses a child whose host recorded nothing to rebuild it from', async () => {
		const { childSessionId, scheduler, second } = await afterRestart({ recordProfile: false })
		expect(
			await scheduler.restoreChild?.({ childSessionId, workingDirectory: '/tmp', agentFor }),
		).toEqual({ status: 'refused', reason: 'not-resumable' })
		await expect(
			scheduler.createTask({ ...second.taskOptions, resumeSessionId: childSessionId }),
		).rejects.toThrow('continuation authority is unavailable')
	})

	it('refuses an id nothing saved, an agent the host cannot rebuild, and a missing layout', async () => {
		const { childSessionId, scheduler } = await afterRestart()
		expect(
			await scheduler.restoreChild?.({
				childSessionId: '11111111-2222-4333-8444-555555555555' as typeof childSessionId,
				workingDirectory: '/tmp',
				agentFor,
			}),
		).toEqual({ status: 'refused', reason: 'not-saved' })
		expect(
			await scheduler.restoreChild?.({
				childSessionId,
				workingDirectory: '/tmp',
				agentFor: () => undefined,
			}),
		).toEqual({ status: 'refused', reason: 'not-resumable' })
		expect(
			await scheduler.restoreChild?.({
				childSessionId,
				workingDirectory: '/tmp',
				agentFor: () => 'no-such-agent',
			}),
		).toEqual({ status: 'refused', reason: 'not-resumable' })

		const inMemory = await harness()
		const memoryScheduler = new LocalTaskScheduler(inMemory.manager, inMemory.context())
		expect(
			await memoryScheduler.restoreChild?.({ childSessionId, workingDirectory: '/tmp', agentFor }),
		).toEqual({ status: 'refused', reason: 'no-layout' })
	})

	it('refuses a child that never recorded the end of a turn', async () => {
		const first = await harness({
			disk: true,
			run: async () => {
				throw new Error('the process went away')
			},
		})
		const gateway = new LocalTaskScheduler(first.manager, first.context())
		const task = await gateway.createTask({ ...first.taskOptions, continuationProfile: profile })
		await gateway.waitForTask(task.taskId).catch(() => undefined)
		const second = await harness({
			restartOf: first,
		})
		const scheduler = new LocalTaskScheduler(second.manager, second.context())
		expect(
			await scheduler.restoreChild?.({
				childSessionId: required(task.childSessionId),
				workingDirectory: '/tmp',
				agentFor,
			}),
		).toEqual({ status: 'refused', reason: 'unsettled' })
	})

	it('does not restore a child twice while its continuation runs', async () => {
		const { childSessionId, scheduler, second } = await afterRestart()
		await scheduler.restoreChild?.({ childSessionId, workingDirectory: '/tmp', agentFor })
		const resumed = await scheduler.createTask({
			...second.taskOptions,
			prompt: 'again',
			resumeSessionId: childSessionId,
		})
		await scheduler.waitForTask(resumed.taskId)
		// Settled again: restoring is idempotent and keeps the same retained conversation.
		expect(
			await scheduler.restoreChild?.({ childSessionId, workingDirectory: '/tmp', agentFor }),
		).toMatchObject({ status: 'restored' })
	})
})
