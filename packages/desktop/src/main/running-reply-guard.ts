/** What the window needs from Electron's dialog, so the question can be tested without Electron. */
export interface MessageDialog {
	showMessageBox(options: {
		type: 'warning'
		title: string
		message: string
		detail: string
		buttons: string[]
		defaultId: number
		cancelId: number
		noLink: boolean
	}): Promise<{ response: number }>
}

export const KEEP_WORKING = 0
export const QUIT_AND_STOP = 1

/** The wording, kept in one place so the question and its tests agree. */
export function stopQuestion(running: number) {
	return {
		type: 'warning' as const,
		title: 'A reply is still running',
		message: running === 1 ? 'A reply is still running.' : `${running} replies are still running.`,
		detail:
			running === 1
				? 'If you quit now, Namzu stops it before it finishes. The conversation will say it was stopped because Namzu was closed.'
				: 'If you quit now, Namzu stops them before they finish. Each conversation will say it was stopped because Namzu was closed.',
		buttons: ['Keep working', 'Quit and stop'],
		defaultId: KEEP_WORKING,
		cancelId: KEEP_WORKING,
		noLink: true,
	}
}

/**
 * Asks before quitting while replies run. Resolves true when the person chose to quit (or nothing
 * runs); one question at a time, so a second close request joins the first.
 */
export class RunningReplyGuard {
	private asking: Promise<boolean> | undefined
	private confirmed = false
	constructor(
		private readonly dialog: MessageDialog,
		private readonly running: () => number,
	) {}
	/** True once the person has said yes; a later quit step does not ask again. */
	get approved(): boolean {
		return this.confirmed
	}
	async confirm(): Promise<boolean> {
		if (this.confirmed) return true
		const running = this.running()
		if (running === 0) return true
		this.asking ??= this.dialog
			.showMessageBox(stopQuestion(running))
			.then((result) => {
				this.confirmed = result.response === QUIT_AND_STOP
				return this.confirmed
			})
			.finally(() => {
				this.asking = undefined
			})
		return this.asking
	}
}
