import { resolve } from 'node:path'

import { resolveNamzuHome } from '@namzu/sdk'

/**
 * The one user-level application home, shared with the SDK: `NAMZU_HOME`,
 * default `~/.namzu`. The resolver lives in the SDK so both sides agree on
 * where `projects/<slug>/` is; it is re-exported here for the CLI's callers.
 */
export { NamzuHomeError, type ResolveNamzuHomeOptions, resolveNamzuHome } from '@namzu/sdk'

/**
 * Compatibility helper for APIs whose existing `home` argument means the OS
 * home, not the application directory. An explicit argument remains the test
 * seam it has always been; production defaults honor `NAMZU_HOME`.
 */
export function namzuHomePath(home?: string): string {
	return home === undefined ? resolveNamzuHome() : resolve(home, '.namzu')
}
