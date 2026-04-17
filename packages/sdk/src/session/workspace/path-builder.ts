/**
 * PathBuilder — canonical filesystem layout generator for the session
 * hierarchy.
 *
 * Replaces the hardcoded `.namzu/threads/{threadId}/runs` path at
 * `runtime/query/context.ts:60-64`. Phase 3 ships the abstraction; wiring
 * into the factory happens in Phase 6 (sub-session spawn refactor) so the
 * cutover is atomic with the new `projectId` / `sessionId` requirements
 * (Convention #0: no dual paths).
 *
 * Layout matches session-hierarchy.md §13.4 (on-disk layout after migration):
 *
 *   {rootDir}/projects/{projectId}/
 *     project.json
 *     sessions/{sessionId}/
 *       session.json
 *       messages.jsonl
 *       subsessions/{subSessionId}/
 *         subsession.json
 *       runs/{runId}/
 *         ...  (Run-pattern owned; unchanged internally)
 */

import { join } from 'node:path'
import type { ProjectId, RunId, SessionId } from '../../types/ids/index.js'
import type { SubSessionId } from '../../types/session/ids.js'

/**
 * Canonical filesystem layout contract. All paths returned are absolute
 * when `root` is absolute (recommended); consumers treat them as opaque.
 */
export interface PathBuilder {
	rootDir(): string
	projectDir(projectId: ProjectId): string
	sessionDir(projectId: ProjectId, sessionId: SessionId): string
	subSessionDir(projectId: ProjectId, sessionId: SessionId, subSessionId: SubSessionId): string
	runDir(projectId: ProjectId, sessionId: SessionId, runId: RunId): string
}

/**
 * Default implementation over `node:path.join`. The `root` constructor
 * argument is injected by the consumer (e.g. `join(cwd, '.namzu')`); no
 * process-global fallback — the kernel refuses to guess paths.
 */
export class DefaultPathBuilder implements PathBuilder {
	private readonly root: string

	constructor(root: string) {
		this.root = root
	}

	rootDir(): string {
		return this.root
	}

	projectDir(projectId: ProjectId): string {
		return join(this.root, 'projects', projectId)
	}

	sessionDir(projectId: ProjectId, sessionId: SessionId): string {
		return join(this.projectDir(projectId), 'sessions', sessionId)
	}

	subSessionDir(projectId: ProjectId, sessionId: SessionId, subSessionId: SubSessionId): string {
		return join(this.sessionDir(projectId, sessionId), 'subsessions', subSessionId)
	}

	runDir(projectId: ProjectId, sessionId: SessionId, runId: RunId): string {
		return join(this.sessionDir(projectId, sessionId), 'runs', runId)
	}
}
