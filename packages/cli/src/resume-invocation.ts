import { constants, accessSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Prefer the public command only when PATH resolves to this exact executable. */
export function resumeInvocation(
	entrypoint: string,
	path = process.env.PATH ?? '',
): readonly [string, ...string[]] {
	if (!entrypoint.endsWith('.ts') && process.platform !== 'win32') {
		for (const directory of path.split(delimiter)) {
			// Relative PATH entries would change meaning after a directory change.
			if (!isAbsolute(directory)) break
			const candidate = join(directory, 'namzu')
			try {
				accessSync(candidate, constants.X_OK)
				if (realpathSync(candidate) === realpathSync(entrypoint)) return ['namzu']
				break
			} catch {
				// Continue past directories without an executable namzu.
			}
		}
	}
	return [process.execPath, ...(entrypoint.endsWith('.ts') ? process.execArgv : []), entrypoint]
}
