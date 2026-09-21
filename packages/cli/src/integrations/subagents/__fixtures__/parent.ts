import {
	InMemorySessionStore,
	InMemoryTopicStore,
	type TurnId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import type { SubagentParent } from '../runtime.js'

/** A real parent hierarchy shared by a query and its delegation resolver. */
export async function subagentParentFixture(cwd: string, turnId: TurnId = generateTurnId()) {
	const tenantId = generateTenantId()
	const sessions = new InMemorySessionStore()
	const project = await sessions.createProject(
		{ tenantId, name: 'test parent', rootPath: cwd },
		tenantId,
	)
	const topic = await new InMemoryTopicStore().createTopic(
		{ projectId: project.id, title: 'test parent' },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: topic.id, currentActor: null },
		tenantId,
	)
	return {
		scope: { turnId, projectId: project.id, topicId: topic.id, sessionId: session.id, tenantId },
		async resolveParent(requested: TurnId): Promise<SubagentParent> {
			if (requested !== turnId) throw new Error(`Unknown parent turn: ${requested}`)
			return { project, topic, sessionId: session.id }
		},
	}
}
