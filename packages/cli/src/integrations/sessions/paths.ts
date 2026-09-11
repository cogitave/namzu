import { join } from 'node:path'
import {
	DefaultPathBuilder,
	type ProjectId,
	type SessionId,
	asProjectId,
	asSessionId,
} from '@namzu/sdk'

/** Application artifacts are keyed by conversation; workspace membership lives in SQLite. */
export class CliPathBuilder extends DefaultPathBuilder {
	override projectDir(projectId: ProjectId): string {
		asProjectId(projectId)
		return this.rootDir()
	}

	override sessionDir(projectId: ProjectId, sessionId: SessionId): string {
		asProjectId(projectId)
		return join(this.projectDir(projectId), 'sessions', asSessionId(sessionId))
	}
}
