import { resolve } from 'node:path'
import type { DiskSessionStore, Project, TenantId } from '@namzu/sdk'

import { instructionSearchPath } from '../../context/project.js'

/** The nearest checkout root, or the working directory for standalone work. */
export function cliProjectRoot(workingDirectory: string): string {
	return instructionSearchPath(workingDirectory)[0] ?? resolve(workingDirectory)
}

/**
 * Keep existing directory-bound history reachable. New directories share their
 * checkout's Project; an older, more specific binding remains authoritative.
 * The caller supplies a canonical working directory, never a symlink alias.
 */
export async function findCliProject(
	store: Pick<DiskSessionStore, 'findProjectByRootPath'>,
	workingDirectory: string,
	tenantId: TenantId,
): Promise<Project | null> {
	const exact = await store.findProjectByRootPath(workingDirectory, tenantId)
	if (exact) return exact
	const root = cliProjectRoot(workingDirectory)
	return root === workingDirectory ? null : store.findProjectByRootPath(root, tenantId)
}
