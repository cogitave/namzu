import { canonicalProjectPath } from '../permissions/canonical-project.js'

/**
 * Internal bridge from a pre-trust context to its project-aware replacement.
 *
 * A WeakMap keeps this authority out of the public CommandContext/TuiContext
 * shapes. Hand-built embedded contexts therefore retain their existing
 * behaviour: resolving them is an identity operation.
 */
const trustedResolvers = new WeakMap<object, (cwd: string) => object>()
const trustedRefreshers = new WeakMap<object, (cwd: string) => object>()

/**
 * `refresh`, when given, re-reads the project's configuration from disk and returns the new
 * context; it must return the last good one when the files no longer load.
 */
export function bindTrustedProjectContext<T extends object>(
	bootstrap: T,
	resolve: (cwd: string) => T,
	refresh?: (cwd: string) => T,
): T {
	trustedResolvers.set(bootstrap, resolve)
	if (refresh) trustedRefreshers.set(bootstrap, refresh)
	return bootstrap
}

/**
 * The project's context with its configuration read again from disk, for a host that starts a
 * conversation long after the process started. A context with no refresher resolves as it always did.
 */
export function refreshTrustedProjectContext<T extends object>(bootstrap: T, cwd: string): T {
	const refresh = trustedRefreshers.get(bootstrap)
	return refresh ? (refresh(cwd) as T) : resolveTrustedProjectContext(bootstrap, cwd)
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

/**
 * Re-reads one project's context and keeps it in `cache`. When the files no longer load
 * (half-written, or invalid) the cache is left as it was, the last good context is returned,
 * and `onError` is told why, so a new conversation never runs on stale settings in silence.
 * A project with nothing cached yet loads through `first`, whose errors are the caller's.
 */
export function refreshCachedContext<T>(
	cache: Map<string, T>,
	target: string,
	first: () => T,
	load: () => T,
	onError: (error: unknown) => void,
): T {
	const cached = cache.get(target)
	if (cached === undefined) return first()
	try {
		const fresh = load()
		cache.set(target, fresh)
		return fresh
	} catch (error) {
		onError(error)
		return cached
	}
}
