import type { DesktopBoot } from '../shared/protocol.js'

/**
 * The pre-paint snapshot main handed to this page, and the one-time right to seed state from
 * it. Only the panes mounted by the launch commit may use it: a pane opened later would start
 * from data that is already stale, and reads the live state instead.
 */
let boot: DesktopBoot | undefined
let seedable = false
export function adoptBoot(value: DesktopBoot | undefined): void {
	boot = value
	seedable = value?.launch === true
}
export function launchSeed(): DesktopBoot | undefined {
	return seedable ? boot : undefined
}
export function settleLaunchSeed(): void {
	seedable = false
}

export type RestoreDecision = 'restore' | 'home'

/**
 * What the pane shows while its saved tab is being brought back.
 *
 * - `restore`: a skeleton of the conversation. Never the home composer, the welcome or an
 *   empty project home: those say "nothing here" about a tab that is coming back.
 * - `home`: the person asked to start on the home screen, there is no tab to restore, the
 *   restore has finished, or it cannot finish (the tab's folder failed to open, or the load
 *   reported an error) and the ordinary screens carry the explanation.
 */
export function restoreDecision(input: {
	/** The saved setting; unknown until the snapshot or the settings read arrives. */
	startupHome: boolean
	activeTabId: string
	restoring: boolean
	/** The load of the active tab already failed. */
	failed: boolean
	/** The active tab's folder, when known. */
	tabProject?: { status: 'connecting' | 'ready' | 'error'; trusted: boolean }
}): RestoreDecision {
	if (input.startupHome || !input.activeTabId || !input.restoring || input.failed) return 'home'
	const folder = input.tabProject
	// A folder that failed to open, or that is not trusted here, will not restore: its own
	// screen (the error, or the trust dialog) says why.
	if (folder && (folder.status === 'error' || (folder.status === 'ready' && !folder.trusted)))
		return 'home'
	return 'restore'
}
