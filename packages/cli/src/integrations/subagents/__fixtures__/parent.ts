import {
	InMemorySessionStore,
	InMemoryTopicStore,
	type RunId,
	generateRunId,
	generateTenantId,
} from '@namzu/sdk'
import type { SubagentParent } from '../runtime.js'

/** A real parent hierarchy shared by a query and its delegation resolver. */
export async function subagentParentFixture(cwd: string, runId: RunId = generateRunId()) {
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
		scope: { runId, projectId: project.id, topicId: topic.id, sessionId: session.id, tenantId },
		async resolveParent(requested: RunId): Promise<SubagentParent> {
			if (requested !== runId) throw new Error(`Unknown parent run: ${requested}`)
			return { project, topic, sessionId: session.id }
		},
	}
}
