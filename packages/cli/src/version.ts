import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Version of the CLI package that owns this process.
 *
 * Read from the published manifest rather than repeated in source. Both this
 * file in `src/` and its compiled twin in `dist/` sit one directory below the
 * package root, so the same lookup serves tests, development and an installed
 * tarball.
 */
export const CLI_VERSION: string = readCliPackageVersion()

function readCliPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
			readonly version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}
