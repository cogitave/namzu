import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The CLI that an installed build carries under `<resources>/cli`. An explicit
 * `NAMZU_DESKTOP_CLI` always wins; an unpackaged app (development) never looks here,
 * and a packaged one without the file falls back to the `namzu` on PATH as before.
 */
export function bundledCliEntry(options: {
	isPackaged: boolean
	resourcesPath: string | undefined
	isFile?: (path: string) => boolean
}): string | undefined {
	if (!options.isPackaged || !options.resourcesPath) return undefined
	const entry = join(options.resourcesPath, 'cli', 'dist', 'bin.js')
	const isFile =
		options.isFile ??
		((path: string) => {
			try {
				return lstatSync(path).isFile()
			} catch {
				return false
			}
		})
	return isFile(entry) ? entry : undefined
}
