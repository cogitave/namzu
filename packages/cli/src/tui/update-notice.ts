/**
 * The standing footer item that says a newer version is out and what to run.
 * It stays at the right end while the check found one; nothing else claims the
 * end of the row except a hint, a notice or a goal.
 */

import type { UpdaterEvent } from '../integrations/auto-update/updater.js'
import type { UpdateInfo } from '../integrations/updates.js'

export function updateAmbient(update: UpdateInfo): {
	readonly text: string
	readonly tone: 'warn'
	readonly strong: string
} {
	return { text: `Update available! Run: ${update.how}`, tone: 'warn', strong: update.how }
}

type AmbientLine = {
	readonly text: string
	readonly tone: 'warn' | 'dim'
	readonly strong?: string
}

/**
 * The one line the background updater leaves in the footer: dim when an
 * update was installed (nothing is shown while it works), yellow with the exact
 * command when Namzu could not or may not do it itself.
 */
export function updaterEventAmbient(event: UpdaterEvent): AmbientLine {
	if (event.type === 'installed') {
		return { text: `Updated to ${event.to}, restart to use it`, tone: 'dim', strong: event.to }
	}
	if (event.command === null) {
		return {
			text: `Namzu ${event.latest} is available. Reinstall Namzu to get it`,
			tone: 'warn',
			strong: event.latest,
		}
	}
	const lead = event.failure ? "Couldn't update Namzu on its own. Run:" : 'Update available! Run:'
	return { text: `${lead} ${event.command}`, tone: 'warn', strong: event.command }
}
