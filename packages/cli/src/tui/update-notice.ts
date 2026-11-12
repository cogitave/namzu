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
	readonly tone: 'warn' | 'dim' | 'ok'
	readonly strong?: string
}

/**
 * The one line the background updater leaves in the footer: a dim "Updating…"
 * while it installs, a green check once an update is installed, yellow with the
 * exact command when Namzu could not or may not do it itself. An install that ended
 * with nothing to say (`idle`) clears the line, which the caller does.
 */
export function updaterEventAmbient(event: Exclude<UpdaterEvent, { type: 'idle' }>): AmbientLine {
	if (event.type === 'installing') {
		return { text: `Updating to ${event.to}…`, tone: 'dim', strong: event.to }
	}
	if (event.type === 'pending') {
		return {
			text: `Update ${event.to} ready · installs when Namzu closes`,
			tone: 'dim',
			strong: event.to,
		}
	}
	if (event.type === 'installed') {
		return { text: `✓ Updated to ${event.to} · restart to use it`, tone: 'ok', strong: event.to }
	}
	if (event.type === 'failed') {
		const what = event.code === 'verify_failed' ? 'could not start here' : 'could not be installed'
		return {
			text: `Namzu ${event.latest} ${what}; staying on ${event.current}`,
			tone: 'dim',
			strong: event.latest,
		}
	}
	if (event.blocked) {
		// The full command does not fit the footer; `namzu doctor` shows it with the reason.
		return {
			text: "Update available, can't install here. See namzu doctor",
			tone: 'warn',
			strong: 'namzu doctor',
		}
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
