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

/**
 * The directory a session's runs live under — `RunDiskStore`'s `baseDir`, and the
 * `baseDir` every durable-decision locator takes.
 *
 * One expression of it, used by everything that has to name it: the runtime, when it
 * builds a run's store; and any caller that has to find a run's record WITHOUT the run
 * — a cancel reaching a suspended child, an operator tool, a resume in a fresh process.
 * A second copy of `join(pathBuilder.sessionDir(...), 'runs')` somewhere else is how the
 * two silently disagree, and a cancel that computes the wrong directory does not fail —
 * it succeeds against nothing ([one-canonical-name](../../../../docs.local/conventions/one-canonical-name.md)).
 */
export function resolveRunsDir(scope: {
	workingDirectory: string
	projectId: ProjectId
	sessionId: SessionId
	pathBuilder?: PathBuilder
}): string {
	const pathBuilder =
		scope.pathBuilder ?? new DefaultPathBuilder(join(scope.workingDirectory, '.namzu'))
	return join(pathBuilder.sessionDir(scope.projectId, scope.sessionId), 'runs')
}
