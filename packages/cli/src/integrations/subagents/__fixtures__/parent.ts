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
	// The turns this parent answers for, each with the session it runs in.
	const turns = new Map<TurnId, typeof session.id>([[turnId, session.id]])
	return {
		/** A later turn of the same conversation. */
		addTurn(): TurnId {
			const later = generateTurnId()
			turns.set(later, session.id)
			return later
		},
		/** A turn of another conversation of the same project and topic. */
		async addForeignTurn(): Promise<TurnId> {
			const other = await sessions.createSession(
				{ projectId: project.id, topicId: topic.id, currentActor: null },
				tenantId,
			)
			const foreign = generateTurnId()
			turns.set(foreign, other.id)
			return foreign
		},
		scope: { turnId, projectId: project.id, topicId: topic.id, sessionId: session.id, tenantId },
		async resolveParent(requested: TurnId): Promise<SubagentParent> {
			const sessionId = turns.get(requested)
			if (sessionId === undefined) throw new Error(`Unknown parent turn: ${requested}`)
			return { project, topic, sessionId }
		},
	}
}
