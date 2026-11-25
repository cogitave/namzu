import { flushStdio } from './flush-stdio.js'
import {
	installWasReplaced,
	replacedInstallLine,
} from './integrations/auto-update/replaced-install.js'
import {
	heldLeaseRelease,
	sessionLeasesMayBeHeld,
	terminationInProgress,
} from './termination-state.js'

/** Give the conversation back even when bounded TUI cleanup left a query unwinding. */
export async function exitProcess(code: number): Promise<void> {
	if (terminationInProgress() !== null) return
	if (sessionLeasesMayBeHeld()) {
		try {
			// The function the command started with: nothing is read from disk on the way out, so a
			// newer version installed over this one meanwhile cannot take it away.
			const release = heldLeaseRelease() ?? (await import('@namzu/sdk')).releaseHeldSessionLeases
			await release()
		} catch (err) {
			// The conversation is closed by its own code before this point; this is only the safety net.
			// Leaving must still work, and say why only when the install was replaced.
			if (installWasReplaced({ error: err })) process.stderr.write(`${replacedInstallLine()}\n`)
		}
	}
	// A signal may have arrived during the release; its handler owns that exit.
	if (terminationInProgress() !== null) return
	// A reader on a pipe still holds what was queued; exiting now would cut it short.
	await flushStdio()
	if (terminationInProgress() !== null) return
	process.exit(code)
}
