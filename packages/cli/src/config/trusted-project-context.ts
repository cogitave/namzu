import { canonicalProjectPath } from '../permissions/canonical-project.js'

/**
 * Internal bridge from a pre-trust context to its project-aware replacement.
 *
 * A WeakMap keeps this authority out of the public CommandContext/TuiContext
 * shapes. Hand-built embedded contexts therefore retain their existing
 * behaviour: resolving them is an identity operation.
 */
const trustedResolvers = new WeakMap<object, (cwd: string) => object>()

export function bindTrustedProjectContext<T extends object>(
	bootstrap: T,
	resolve: (cwd: string) => T,
): T {
	trustedResolvers.set(bootstrap, resolve)
	return bootstrap
}

export function resolveTrustedProjectContext<T extends object>(bootstrap: T, cwd: string): T {
	const resolve = trustedResolvers.get(bootstrap)
	return resolve ? (resolve(cwd) as T) : bootstrap
}

/**
 * Pin a real project path only for contexts the CLI marked as trust-aware.
 *
 * Embedded/hand-built contexts keep their historical lexical cwd behaviour;
 * production bootstrap contexts cannot proceed if their target disappears
 * while crossing the trust boundary.
 */
export function pinTrustedProjectPath(bootstrap: object, cwd: string): string {
	return trustedResolvers.has(bootstrap) ? canonicalProjectPath(cwd) : cwd
}
