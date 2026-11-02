/**
 * Reads the live state of one session from the places the host keeps it.
 *
 * The host passes accessors rather than the objects, because most of them
 * come into being after the session does (the agent runtime, the workflow
 * host) and some are absent in a given run. Each call reads fresh; nothing is
 * remembered between requests.
 */

import type { BackgroundJobRegistry, SessionId } from '@namzu/sdk'

import type { SubagentActivitySource } from '../subagents/activity.js'
import type { WorkflowRunView } from '../workflows/view.js'
import type { JobFact, OutstandingFacts } from './collect.js'

export interface OutstandingFactSources {
	readonly jobs: () => BackgroundJobRegistry | undefined
	/** The id background jobs of this session are owned by. */
	readonly jobOwner: string
	readonly activity: () => SubagentActivitySource | undefined
	/** Every workflow run of the conversation, ended ones included. */
	readonly workflows: (sessionId: SessionId) => readonly WorkflowRunView[]
	readonly agentId?: OutstandingFacts['agentId']
}

export function createOutstandingFacts(
	sources: OutstandingFactSources,
): (sessionId: SessionId) => Omit<OutstandingFacts, 'now'> {
	return (sessionId) => {
		const registry = sources.jobs()
		const jobs: JobFact[] = registry
			? registry.list(sources.jobOwner).map((job) => ({
					id: job.id,
					command: job.command,
					...(job.description !== undefined ? { description: job.description } : {}),
					...(job.kind !== undefined ? { kind: job.kind } : {}),
					status: job.status,
					startedAt: job.startedAt,
					...(job.lastOutputAt !== undefined ? { lastOutputAt: job.lastOutputAt } : {}),
					...(job.lastOutputLine !== undefined ? { lastOutputLine: job.lastOutputLine } : {}),
					alive: job.status === 'running' && registry.isAlive(job.id),
				}))
			: []
		return {
			jobs,
			agents: sources.activity()?.getSnapshot() ?? [],
			workflows: sources.workflows(sessionId),
			...(sources.agentId ? { agentId: sources.agentId } : {}),
		}
	}
}
