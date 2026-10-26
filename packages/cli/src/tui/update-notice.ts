/**
 * The standing footer item that says a newer version is out and what to run.
 * It stays at the right end while the check found one; nothing else claims the
 * end of the row except a hint, a notice or a goal.
 */

import type { UpdateInfo } from '../integrations/updates.js'

export function updateAmbient(update: UpdateInfo): {
	readonly text: string
	readonly tone: 'warn'
	readonly strong: string
} {
	return { text: `Update available! Run: ${update.how}`, tone: 'warn', strong: update.how }
}
