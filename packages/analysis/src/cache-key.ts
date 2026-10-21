import { createHash } from 'node:crypto'

/** The key a cache file is named by: the canonical root, hashed. */
export function cacheKey(root: string): string {
	return createHash('sha256').update(root).digest('hex').slice(0, 16)
}
