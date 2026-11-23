import type { SessionId } from '@namzu/sdk'

import type { WorkflowRunView } from './view.js'

/**
 * Which session owns each workflow run. A run stays owned after it ends, so the
 * status read still lists it (with how long ago it finished) instead of an
 * empty answer for work that just completed. An entry goes away once the
 * registry no longer holds the run.
 */
export class WorkflowOwners {
	private readonly owners = new Map<string, SessionId>()

	set(runId: string, sessionId: SessionId): void {
		this.owners.set(runId, sessionId)
	}

	/** The runs of one session among the registry's runs, ended ones included. */
	ownedBy(sessionId: SessionId, runs: readonly WorkflowRunView[]): readonly WorkflowRunView[] {
		const held = new Set(runs.map((run) => run.runId))
		for (const runId of this.owners.keys()) if (!held.has(runId)) this.owners.delete(runId)
		return runs.filter((run) => this.owners.get(run.runId) === sessionId)
	}
}
