import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { parse, resolve } from 'node:path'

/** The one user-level application home used by every Namzu CLI subsystem. */
export interface ResolveNamzuHomeOptions {
	/** OS home override for embedding and tests. */
	readonly home?: string
	/** Environment override for embedding and tests. */
	readonly env?: NodeJS.ProcessEnv
}

export class NamzuHomeError extends Error {
	override readonly name = 'NamzuHomeError'
}

/**
 * Resolve the user-level Namzu application home without creating it.
 *
 * `NAMZU_HOME` is an explicit operator assertion, so it is validated more
 * strictly than the default: it must already be a real directory and its
 * canonical identity is returned. The default remains creatable on first use.
 */
export function resolveNamzuHome(options: ResolveNamzuHomeOptions = {}): string {
	const env = options.env ?? process.env
	const configured = env.NAMZU_HOME
	if (configured === undefined || configured.length === 0) {
		return resolve(options.home ?? homedir(), '.namzu')
	}
	if (configured.includes('\0')) {
		throw new NamzuHomeError('NAMZU_HOME contains a NUL byte and cannot name a directory.')
	}

	let entry: ReturnType<typeof lstatSync>
	try {
		entry = lstatSync(configured)
	} catch (error) {
		throw new NamzuHomeError(
			`NAMZU_HOME points to ${JSON.stringify(configured)}, but that path cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new NamzuHomeError(
			`NAMZU_HOME points to ${JSON.stringify(configured)}, but it is not a real directory.`,
		)
	}

	let canonical: string
	try {
		canonical = realpathSync(configured)
	} catch (error) {
		throw new NamzuHomeError(
			`NAMZU_HOME ${JSON.stringify(configured)} could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (canonical === parse(canonical).root) {
		throw new NamzuHomeError(
			`NAMZU_HOME must not be a filesystem root: ${JSON.stringify(canonical)}. Choose a dedicated directory.`,
		)
	}
	return canonical
}

/**
 * Compatibility helper for APIs whose existing `home` argument means the OS
 * home, not the application directory. An explicit argument remains the test
 * seam it has always been; production defaults honor `NAMZU_HOME`.
 */
export function namzuHomePath(home?: string): string {
	return home === undefined ? resolveNamzuHome() : resolve(home, '.namzu')
}
