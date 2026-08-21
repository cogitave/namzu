import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resolve a project path once at the authority boundary.
 *
 * Every operation admitted by a trust decision must keep this exact result.
 * Re-resolving a lexical symlink later would let it be redirected after the
 * operator approved a different directory.
 */
export function canonicalProjectPath(dir: string): string {
	return realpathSync(resolve(dir))
}
