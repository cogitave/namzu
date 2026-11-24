import { FileTaskStore, TeamStore } from '@namzu/sdk'

import type { TeamsConfig } from '../../config/schema.js'
import { decideTeams, teamsLimits } from './enabled.js'
import type { TeamsHost } from './runner.js'

/** Where a session reads the teams switch from: the live `teams` settings and the environment. */
export interface TeamsSource {
	/** The `teams` section of the resolved config, read now. */
	readonly config: () => TeamsConfig | undefined
	readonly env?: () => NodeJS.ProcessEnv
}

/**
 * The host a session hands its delegation runtime: the switch (asked again at every named `Agent` call),
 * the limits, the team files, and one shared task list per team. Built only for a session with a person
 * at it; a headless run never gets one, so a named `Agent` call there is a plain sub-agent.
 */
export function createTeamsHost(
	source: TeamsSource,
	overrides: Partial<TeamsHost> = {},
): TeamsHost {
	const lists = new Map<string, FileTaskStore>()
	return {
		enabled: () =>
			decideTeams({
				config: source.config,
				env: source.env ?? (() => process.env),
				interactive: true,
			}),
		limits: () => teamsLimits(source.config()),
		store: new TeamStore(),
		taskStoreFor: (team) => {
			let list = lists.get(team)
			if (!list) {
				list = new FileTaskStore({ listId: team })
				lists.set(team, list)
			}
			return list
		},
		...overrides,
	}
}
