/**
 * Where a project's and a user's agent files live.
 *
 * What an agent file MEANS is the kernel's decision (`@namzu/sdk`
 * `agents/file-definitions`): the frontmatter, the allowlist, the refusals.
 * This file only says which directories this application reads, in which
 * order — user first, project second, so a project file shadows a user one
 * with the same name — and hands the kernel the roots.
 */

import { join } from 'node:path'

import {
	type DiscoveredAgentDefinitions,
	discoverAgentDefinitions as discoverFromRoots,
} from '@namzu/sdk'

import { namzuHomePath } from '../state/home.js'

export type { AgentFileDefinition, SkippedAgentFile } from '@namzu/sdk'

export function userAgentsDir(home?: string): string {
	return join(namzuHomePath(home), 'agents')
}

export function projectAgentsDir(cwd: string): string {
	return join(cwd, '.namzu', 'agents')
}

/** Both directories, project shadowing user. */
export function discoverAgentDefinitions(opts: {
	readonly cwd: string
	readonly home?: string
}): Promise<DiscoveredAgentDefinitions> {
	return discoverFromRoots([
		{ dir: userAgentsDir(opts.home), source: 'user' },
		{ dir: projectAgentsDir(opts.cwd), source: 'project' },
	])
}
