import { describe, expect, it } from 'vitest'
import {
	InMemorySessionStore,
	InMemoryTopicStore,
	StaleTopicError,
	TopicArchivedError,
	TopicManager,
	TopicNotEmptyError,
} from '../index.js'
import type { TenantId, UserId } from '../index.js'

const tenantId = 'tnt_topic_public' as TenantId

async function setup() {
	const sessionStore = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()
	const project = await sessionStore.createProject(
		{ tenantId, name: 'public Topic errors' },
		tenantId,
	)
	const topic = await topicStore.createTopic(
		{ projectId: project.id, title: 'public Topic errors' },
		tenantId,
	)
	const manager = new TopicManager({ topicStore, sessionStore })
	return { manager, project, sessionStore, topic, topicStore }
}

async function rejected(operation: Promise<unknown>): Promise<Error & { details: unknown }> {
	try {
		await operation
	} catch (error) {
		return error as Error & { details: unknown }
	}
	throw new Error('Expected operation to reject')
}

describe('Topic errors are a package-root contract', () => {
	it('names a stale Topic update without reviving Thread vocabulary', async () => {
		const { topic, topicStore } = await setup()
		await topicStore.updateTopic({ ...topic, title: 'winner' }, tenantId)

		const error = await rejected(topicStore.updateTopic({ ...topic, title: 'stale' }, tenantId))

		expect(error).toBeInstanceOf(StaleTopicError)
		expect(error.name).toBe('StaleTopicError')
		expect(error.details).toEqual({
			topicId: topic.id,
			expectedVersion: 0,
			actualVersion: 1,
		})
		expect(JSON.stringify(error)).toContain('topicId')
		expect(JSON.stringify(error)).not.toContain('threadId')
	})

	it('names the archived Topic gate from the package root', async () => {
		const { manager, topic, topicStore } = await setup()
		await topicStore.updateTopic({ ...topic, status: 'archived' }, tenantId)

		const error = await rejected(manager.requireOpen(topic.id, tenantId))

		expect(error).toBeInstanceOf(TopicArchivedError)
		expect(error.name).toBe('TopicArchivedError')
		expect(error.details).toEqual({ topicId: topic.id, op: 'require-open' })
		expect(JSON.stringify(error)).toContain('topicId')
		expect(JSON.stringify(error)).not.toContain('threadId')
	})

	it('names an attached Session that blocks Topic deletion', async () => {
		const { manager, project, sessionStore, topic } = await setup()
		const session = await sessionStore.createSession(
			{
				topicId: topic.id,
				projectId: project.id,
				currentActor: {
					kind: 'user',
					userId: 'usr_topic_public' as UserId,
					tenantId,
				},
			},
			tenantId,
		)

		const error = await rejected(manager.delete(topic.id, tenantId))

		expect(error).toBeInstanceOf(TopicNotEmptyError)
		expect(error.name).toBe('TopicNotEmptyError')
		expect(error.details).toEqual({
			topicId: topic.id,
			tenantId,
			op: 'delete',
			blockingSessions: [{ sessionId: session.id, status: 'idle' }],
			totalBlockingSessions: 1,
		})
		expect(JSON.stringify(error)).toContain('topicId')
		expect(JSON.stringify(error)).not.toContain('threadId')
	})
})
