import { RECORDING_WORDS } from '../../shared/recording-protocol.js'
import type { MessageDialog } from '../running-reply-guard.js'

/**
 * A recording lives in memory only, so quitting loses it. When one is running or waiting for review,
 * quitting asks first and says so. One question at a time.
 */
export const KEEP_RECORDING = 0
export const QUIT_AND_LOSE = 1

export function recordingQuitQuestion() {
	return {
		type: 'warning' as const,
		title: 'A screen recording is waiting',
		message: RECORDING_WORDS.quitWarning,
		detail:
			'The recording is kept in memory only, and nothing was saved to disk. Press Send on the review sheet first if you want to keep it.',
		buttons: ['Keep Namzu open', 'Quit and lose it'],
		defaultId: KEEP_RECORDING,
		cancelId: KEEP_RECORDING,
		noLink: true,
	}
}

export class RecordingQuitGuard {
	private asking: Promise<boolean> | undefined
	private confirmed = false
	constructor(
		private readonly dialog: MessageDialog,
		private readonly holds: () => boolean,
	) {}

	get approved(): boolean {
		return this.confirmed
	}

	async confirm(): Promise<boolean> {
		if (this.confirmed || !this.holds()) return true
		this.asking ??= this.dialog
			.showMessageBox(recordingQuitQuestion())
			.then((result) => {
				this.confirmed = result.response === QUIT_AND_LOSE
				return this.confirmed
			})
			.finally(() => {
				this.asking = undefined
			})
		return this.asking
	}
}
