import type { PeerSessionState } from '@namzu/sdk'

/** What a session is doing, as the host knows it. */
export type SessionActivity =
	| 'not-started'
	| 'starting'
	| 'working'
	| 'needs-approval'
	| 'idle'
	| 'exited'

/** The one dot a row shows. `done` is a finished turn nobody has looked at yet. */
export type Dot = 'blocked' | 'done' | 'working' | 'idle' | 'none'

const PRIORITY: readonly Dot[] = ['blocked', 'done', 'working', 'idle', 'none']

/**
 * Combines what the session's own terminal last reported with what the host sees
 * of the process. A terminal that has not reported yet is `starting`.
 */
export function deriveActivity(
	child: 'none' | 'starting' | 'running' | 'exited',
	reported: PeerSessionState | undefined,
): SessionActivity {
	if (child === 'none') return 'not-started'
	if (child === 'exited') return 'exited'
	if (reported === undefined) return 'starting'
	if (reported === 'busy') return 'working'
	return reported === 'awaiting-permission' ? 'needs-approval' : 'idle'
}

export function dotFor(activity: SessionActivity, unseen: boolean): Dot {
	if (activity === 'needs-approval') return 'blocked'
	if (activity === 'exited' || activity === 'not-started' || activity === 'starting') return 'none'
	if (unseen) return 'done'
	return activity === 'working' ? 'working' : 'idle'
}

/** The most urgent dot of a group: blocked, then finished-unseen, then working, then idle. */
export function aggregateDot(dots: readonly Dot[]): Dot {
	for (const dot of PRIORITY) if (dots.includes(dot)) return dot
	return 'none'
}

/** The plain words under a row, or nothing when the dot says enough. */
export function activityNote(
	activity: SessionActivity,
	unseen: boolean,
	ending?: 'finished' | 'stopped' | 'could-not-start',
): string | undefined {
	switch (activity) {
		case 'not-started':
			return 'not started'
		case 'starting':
			return 'starting'
		case 'needs-approval':
			return 'needs approval'
		case 'working':
			return unseen ? 'finished' : 'working'
		case 'idle':
			return unseen ? 'finished' : undefined
		case 'exited':
			if (ending === 'could-not-start') return 'could not start'
			return ending === 'finished' ? 'ended' : 'stopped'
	}
}

/** The note a space row carries when something in it wants a look. */
export function spaceNote(dot: Dot): string | undefined {
	if (dot === 'blocked') return 'needs approval'
	if (dot === 'done') return 'finished, not seen'
	return undefined
}
