/** Where an install's update files live, and the key they are filed under. Light: loaded by every turn-capable command. */

import { join } from 'node:path'

import type { InstallKind } from './install-kind.js'
import { installScope } from './state.js'

/** The key an install's lock, marker and kept copies are filed under: its prefix, or pnpm's global folder. */
export function scopeOf(
	install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>,
	platform: NodeJS.Platform = process.platform,
): string {
	return installScope(install.kind === 'pnpm-global' ? install.globalDir : install.prefix, platform)
}

/**
 * Where the lock and the in-progress marker of an install live: inside the install
 * itself, which must be writable for an update to run at all. Every process that can
 * write the install, whatever its Namzu home or user, sees the same files.
 */
export function sharedStateHome(
	install: Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>,
): string {
	return join(install.kind === 'pnpm-global' ? install.globalDir : install.prefix, '.namzu-update')
}
