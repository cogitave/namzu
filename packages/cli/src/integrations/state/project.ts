import { resolve } from 'node:path'
import type { DiskSessionStore, Project, TenantId } from '@namzu/sdk'

import { instructionSearchPath } from '../../context/project.js'

/** The nearest checkout root, or the working directory for standalone work. */
export function cliProjectRoot(workingDirectory: string): string {
	return instructionSearchPath(workingDirectory)[0] ?? resolve(workingDirectory)
}

/**
 * Every directory in one checkout resolves through the same root binding.
 * Directory-specific historical bindings do not override that scope.
 * The caller supplies a canonical working directory, never a symlink alias.
 */
export async function findCliProject(
	store: Pick<DiskSessionStore, 'findProjectByRootPath'>,
	workingDirectory: string,
	tenantId: TenantId,
): Promise<Project | null> {
	return store.findProjectByRootPath(cliProjectRoot(workingDirectory), tenantId)
}
