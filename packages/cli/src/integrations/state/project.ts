import { resolve } from 'node:path'

import { instructionSearchPath } from '../../context/project.js'

/**
 * The nearest checkout root, or the working directory for standalone work.
 *
 * This is the directory a CLI project stands for: `openSessions` hands it to
 * the SDK's `ensureProject`, so every directory of one checkout files its
 * conversations under the same `projects/<slug>/`.
 */
export function cliProjectRoot(workingDirectory: string): string {
	return instructionSearchPath(workingDirectory)[0] ?? resolve(workingDirectory)
}
