import { InMemorySessionLog } from '../store/session-log/index.js'
import type { BaseAgentConfig } from '../types/agent/base.js'
import type { ChildSessionStorage } from '../types/agent/task.js'

/**
 * What an agent tells the children it delegates to about where their
 * sessions live.
 *
 * A session held in memory (an {@link InMemorySessionLog} and no `paths`)
 * hands that choice down, with its checkpoint store when it named one, so a
 * child does not fall back to a disk log under `NAMZU_HOME` its parent never
 * asked for. Anything else says nothing, and each child resolves its own
 * storage from its config.
 */
export function childSessionStorage(
	config: Pick<BaseAgentConfig, 'sessionLog' | 'paths' | 'checkpointStore'>,
): ChildSessionStorage | undefined {
	if (!(config.sessionLog instanceof InMemorySessionLog) || config.paths !== undefined) {
		return undefined
	}
	return {
		kind: 'memory',
		...(config.checkpointStore ? { checkpointStore: config.checkpointStore } : {}),
	}
}
