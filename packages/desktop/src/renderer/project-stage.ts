import type { ProjectView } from '../shared/protocol.js'

/** A quick open should not flash a spinner, so the placeholder stays blank for this long. */
export const connectingQuietMs = 400

export type ProjectStageKind = 'connecting' | 'error' | 'gate' | 'ready'

/**
 * What the stage shows for a project. Trust is only known once the runtime answers, so a project
 * that is still connecting never gets the trust gate. Pal and chat workspaces keep the gate path
 * for a failed connection, together with the banner that already handles it.
 */
export function projectStage(
	project: Pick<ProjectView, 'status' | 'trusted' | 'palId' | 'isChat'>,
): ProjectStageKind {
	if (project.status === 'connecting') return 'connecting'
	if (project.status === 'error' && !project.palId && !project.isChat) return 'error'
	return project.trusted ? 'ready' : 'gate'
}

/** Calls `show` after the quiet period; the returned function cancels it. */
export function afterQuietPeriod(show: () => void, ms = connectingQuietMs): () => void {
	const timer = setTimeout(show, ms)
	return () => clearTimeout(timer)
}
