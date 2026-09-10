import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLI_VERSION } from './version.js'

/** Fingerprint executable CLI files, independent of checkout path and timestamps. */
export function fingerprintCli(directory: string): string {
	const hash = createHash('sha256')
	const visit = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name, 'en'),
		)) {
			const path = join(folder, entry.name)
			if (
				entry.isDirectory() &&
				!['node_modules', '__tests__', '__fixtures__'].includes(entry.name)
			)
				visit(path)
			else if (
				entry.isFile() &&
				/\.(js|ts|tsx)$/.test(entry.name) &&
				!/\.(d|test|proc-test)\.(js|ts|tsx)$/.test(entry.name)
			) {
				hash.update(relative(directory, path).replaceAll('\\', '/'))
				hash.update('\0')
				hash.update(readFileSync(path))
				hash.update('\0')
			}
		}
	}
	visit(directory)
	return hash.digest('hex').slice(0, 16)
}

let cached: readonly (readonly [string, string])[] | undefined
/** Local diagnostic only: no credentials, network calls or git lookup. */
export function installationRows(): readonly (readonly [string, string])[] {
	if (cached) return cached
	const directory = dirname(fileURLToPath(import.meta.url))
	let fingerprint = 'unavailable'
	try {
		fingerprint = fingerprintCli(directory)
	} catch {
		/* Diagnostics must not prevent /status. */
	}
	cached = [
		['Version', CLI_VERSION],
		['Build', fingerprint],
		['Executable', join(directory, import.meta.url.endsWith('.ts') ? 'bin.ts' : 'bin.js')],
	]
	return cached
}
