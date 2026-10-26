import { existsSync, lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { SessionPaths, SqliteLearningStore } from '@namzu/sdk'
import { findResidentProject } from '../resident/storage.js'
import { resolveNamzuHome } from '../state/home.js'
import { readIdentity } from '../state/identity.js'
import { cliProjectRoot } from '../state/project.js'
import { SESSION_AGENT_KEY } from './session-feed.js'

/**
 * The project's conversation observations, opened read-only unless `readOnly` is false. Null when this
 * folder has no project, no identity, or nothing has been recorded. Needs no
 * resident.
 */
export async function sessionLearningStore(
	cwd: string,
	readOnly = true,
): Promise<SessionLearningTarget | null> {
	const root = resolveNamzuHome()
	const identity = readIdentity(root)
	if (!identity) return null
	const project = await findResidentProject(root, cliProjectRoot(await realpath(resolve(cwd))))
	if (!project) return null
	const directory = join(
		new SessionPaths({ home: root, slug: project.slug }).projectDir(),
		'learning',
	)
	const databasePath = join(directory, 'learning.sqlite')
	if (!existsSync(databasePath)) return null
	for (const entry of [directory, databasePath]) {
		const stat = lstatSync(entry)
		if (stat.isSymbolicLink() || (entry === databasePath ? !stat.isFile() : !stat.isDirectory()))
			throw new Error(`Learning state requires a private regular path: ${entry}`)
	}
	const paths = new SessionPaths({ home: root, slug: project.slug })
	return Object.assign(
		new SqliteLearningStore({
			databasePath,
			artifactsPath: join(directory, 'artifacts'),
			scope: {
				tenantId: identity.tenantId,
				projectId: project.projectId,
				agentKey: SESSION_AGENT_KEY,
			},
			readOnly,
		}),
		{ target: { paths, tenantId: identity.tenantId, projectId: project.projectId } },
	)
}

/** What a caller needs besides the store to activate guidance for this project. */
export interface SessionLearningTarget extends SqliteLearningStore {
	readonly target: {
		readonly paths: SessionPaths
		readonly tenantId: string
		readonly projectId: string
	}
}
