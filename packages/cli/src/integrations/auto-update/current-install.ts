/** Where this copy of Namzu lives and which Namzu home its update files are in. */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNamzuHome } from '../state/home.js'
import { type InstallKind, classifyInstall, realRoot } from './install-kind.js'

const PACKAGE_ROOT = realRoot(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))

/** Where this copy lives and which Namzu home its update files are in; null without a home. */
export function currentInstall(
	env: NodeJS.ProcessEnv = process.env,
): { readonly install: InstallKind; readonly home: string } | null {
	let home: string
	try {
		home = resolveNamzuHome({ env })
	} catch {
		return null
	}
	const install = classifyInstall({
		packageRoot: PACKAGE_ROOT,
		platform: process.platform,
		namzuHome: home,
		env,
		isElectron: process.versions.electron !== undefined,
	})
	return { install, home }
}
