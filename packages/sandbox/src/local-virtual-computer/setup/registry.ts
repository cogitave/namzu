import { LocalCommandError } from '../engine.js'

/** Run `reg.exe` with these arguments and return what it printed. */
export type RegistryRun = (args: readonly string[]) => Promise<string>

function parentOf(key: string): string | undefined {
	const cut = key.lastIndexOf('\\')
	return cut > 0 ? key.slice(0, cut) : undefined
}

/**
 * `reg query` exits 1 both for a key that is not there and for one the caller
 * may not read, and its words are localised, so the exit status alone cannot
 * tell them apart. Ask the parent instead: its listing of subkeys names the
 * key in every language. A key the parent lists but the query cannot read is
 * not absent, and neither is a parent that cannot be read.
 *
 * Returns the key's listing, or undefined when the key is provably absent.
 * Anything else rethrows the failure.
 */
export async function queryRegistryKey(run: RegistryRun, key: string): Promise<string | undefined> {
	try {
		return await run(['query', key])
	} catch (error) {
		if (!(error instanceof LocalCommandError) || error.exitCode !== 1) throw error
		const parent = parentOf(key)
		if (parent === undefined) throw error
		const listing = await run(['query', parent])
		const leaf = key.slice(parent.length + 1).toLowerCase()
		const listed = listing
			.split(/\r?\n/)
			.some((line) => line.trim().toLowerCase().endsWith(`\\${leaf}`))
		if (listed) throw error
		return undefined
	}
}

/** True when a `reg query <key>` listing carries a value of this name. */
export function listingHasValue(listing: string, name: string): boolean {
	const wanted = name.toLowerCase()
	return listing.split(/\r?\n/).some((line) => {
		const match = /^\s+(.+?)\s+REG_[A-Z_]+(?:\s|$)/.exec(line)
		return match?.[1]?.toLowerCase() === wanted
	})
}
