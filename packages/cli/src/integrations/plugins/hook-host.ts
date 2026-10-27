/**
 * What a hook script is told about the session around it.
 *
 * A hook's stdin carries the transcript file and the permission mode so a
 * script can read the conversation or behave differently under a stricter
 * mode. The mode goes out in the words hook scripts commonly test for, not the
 * kernel's review-mode names, so one script runs under more than one host.
 */

import type { ReviewMode } from '@namzu/sdk'

/** The permission-mode word a hook script reads for a kernel review mode. */
export function hookPermissionMode(mode: ReviewMode): string {
	switch (mode) {
		case 'accept-edits':
			return 'acceptEdits'
		case 'plan':
			return 'plan'
		case 'bypass':
			// An unattended run approves whatever nothing escalated: the closest
			// word is the one for a run that is not asking.
			return 'bypassPermissions'
		case 'auto':
			return 'bypassPermissions'
		case 'classify':
			return 'auto'
		default:
			return 'default'
	}
}

/**
 * The word a hook is told before any turn has attached the live mode control:
 * the mode the session was configured with, else the one an interactive
 * session starts in (it asks), never a mode that stops asking.
 */
export function hookSessionMode(
	live: ReviewMode | undefined,
	configured: ReviewMode | undefined,
): string {
	return hookPermissionMode(live ?? configured ?? 'prompt')
}
