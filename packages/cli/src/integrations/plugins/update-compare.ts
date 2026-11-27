/**
 * What an update changes in what a plugin runs, compared with what the person agreed to when it was
 * installed. One reader for the command line and the desktop host, so both ask for a yes in exactly
 * the same cases.
 */

import type { InstallManifest } from './install-manifest.js'
import type { InstallPlan } from './install-plan.js'
import { isExecutablePath, surfaceChanges } from './surface.js'

export interface UpdateComparison {
	/** One sentence per difference in what runs. */
	readonly changes: readonly string[]
	/**
	 * Nothing that runs changed: the same surface digest, or the same surface rows with only manifests
	 * and files that cannot run and configure nothing differing. Such an update needs no new yes.
	 */
	readonly unchangedSurface: boolean
}

export function compareUpdate(recorded: InstallManifest, plan: InstallPlan): UpdateComparison {
	const before = recorded.surface as unknown as Parameters<typeof surfaceChanges>[0]
	const changes = surfaceChanges(before, plan.surface)
	const nothingRunsDifferently =
		JSON.stringify(before) === JSON.stringify(plan.surface) &&
		[...new Set([...Object.keys(plan.files), ...Object.keys(recorded.files)])]
			.filter((path) => plan.files[path] !== recorded.files[path])
			.every((path) => {
				const base = path.split('/').pop() ?? path
				if (base === 'plugin.json') return true
				return (
					!isExecutablePath(path, 0) && !plan.surface.scripts.some((script) => script.path === path)
				)
			})
	return {
		changes,
		unchangedSurface: recorded.surfaceSha256 === plan.digest || nothingRunsDifferently,
	}
}
