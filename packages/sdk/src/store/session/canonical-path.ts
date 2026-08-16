import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * One directory, one string.
 *
 * `/tmp/p`, `/tmp/p/`, `./p` from `/tmp`, and a symlink pointing at it are
 * four spellings of one place. Storing whichever one the caller happened
 * to type makes four project records for one directory, and every
 * uniqueness check passes while doing it.
 *
 * `realpath` follows symlinks and normalizes, which is what makes those
 * four collapse. A path that does not exist yet cannot be resolved that
 * way, so it falls back to `resolve` — absolute and normalized, just not
 * symlink-followed. That is the honest best available answer rather than a
 * refusal: binding a project to a directory you are about to create is an
 * ordinary thing to want, and refusing it would push every caller into
 * creating the directory first for the store's benefit.
 */
export async function canonicalizePath(input: string): Promise<string> {
	const absolute = resolve(input)
	try {
		return await realpath(absolute)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return absolute
		throw err
	}
}

/**
 * The index key a canonical path takes for one tenant.
 *
 * Tenant is IN the key rather than filtered afterwards. Two tenants on one
 * machine may legitimately bind projects to the same directory, and a
 * path-only key would hand one of them the other's project id — a
 * cross-tenant read through a lookup nobody thought of as a read.
 *
 * A NUL byte separates them, because it is the one character that cannot
 * appear in a path on any platform this runs on. A printable separator
 * could be forged: a tenant id or a directory name containing it would
 * produce a key that collides with a different (tenant, path) pair.
 */
export function rootPathIndexKey(canonicalPath: string, tenantId: string): string {
	return `${tenantId}\0${canonicalPath}`
}
