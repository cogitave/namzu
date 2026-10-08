import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RuntimeVersions {
	cliVersion?: string
	sdkVersion?: string
}

function versionOf(path: string, read: (path: string) => string): string | undefined {
	try {
		const value = (JSON.parse(read(path)) as { version?: unknown }).version
		return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value) ? value : undefined
	} catch {
		return undefined
	}
}

/**
 * The CLI the app runs and the SDK it carries, read from their `package.json` files beside the
 * entry (`<cli>/dist/bin.js`). Both are best effort: an unreadable file is simply not shown.
 */
export function readRuntimeVersions(
	cliEntry: string | undefined,
	read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): RuntimeVersions {
	if (!cliEntry) return {}
	const root = dirname(dirname(cliEntry))
	const cliVersion = versionOf(join(root, 'package.json'), read)
	const sdkVersion = versionOf(join(root, 'node_modules', '@namzu', 'sdk', 'package.json'), read)
	return {
		...(cliVersion ? { cliVersion } : {}),
		...(sdkVersion ? { sdkVersion } : {}),
	}
}
