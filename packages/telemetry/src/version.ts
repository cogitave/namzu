import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The telemetry package version, read from package.json relative to this module.
 *
 * Wrapped in try/catch (mirroring the CLI's readPackageVersion): a bundler
 * like esbuild collapses the whole dist tree into a single file, so at runtime
 * `../package.json` no longer resolves next to the bundle. Without the guard,
 * this module's top-level read throws at import time and takes the entire
 * process down. The version string is cosmetic, so a placeholder is fine.
 */
function readVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

export const VERSION: string = readVersion()
