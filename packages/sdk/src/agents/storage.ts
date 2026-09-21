import { defaultSessionPaths } from '../runtime/query/session-storage.js'
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
 * asked for.
 *
 * A session on disk hands down its layout: the `paths` it named or, with no
 * log and no `paths`, the default layout for its working directory — the one
 * its own log resolves to. Its children's logs then nest under its session
 * directory, with their meta documents, however deep the delegation goes.
 *
 * A host log of its own with no `paths` says nothing: its layout is not
 * known, and each child resolves its own storage from its config.
 */
export async function childSessionStorage(
	config: Pick<BaseAgentConfig, 'sessionLog' | 'paths' | 'checkpointStore'>,
	workingDirectory?: string,
): Promise<ChildSessionStorage | undefined> {
	if (config.paths !== undefined) return { kind: 'disk', paths: config.paths }
	if (config.sessionLog instanceof InMemorySessionLog) {
		return {
			kind: 'memory',
			...(config.checkpointStore ? { checkpointStore: config.checkpointStore } : {}),
		}
	}
	if (config.sessionLog !== undefined) return undefined
	return { kind: 'disk', paths: await defaultSessionPaths(workingDirectory) }
}
