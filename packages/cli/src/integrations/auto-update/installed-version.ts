import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The version of the `@namzu/cli` package folder at `packageRoot`. Throws when it is not that package. */
export function readInstalledVersion(packageRoot: string): string {
	const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
		name?: unknown
		version?: unknown
	}
	if (parsed.name !== '@namzu/cli') throw new Error('the package root is not @namzu/cli')
	if (typeof parsed.version !== 'string') throw new Error('the package has no readable version')
	return parsed.version
}
