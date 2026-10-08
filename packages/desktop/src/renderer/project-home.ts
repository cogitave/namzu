import type { ProjectView } from '../shared/protocol.js'

export const DEFAULT_HOME_HEADING = 'What would you like to work on?'

/** The heading above an empty conversation: a real project names itself. */
export function projectHomeHeading(
	project: Pick<ProjectView, 'name' | 'palId' | 'isChat'> | undefined,
): string {
	if (!project || project.palId !== undefined || project.isChat) return DEFAULT_HOME_HEADING
	return `What should we work on in ${project.name}?`
}

/** Electron prefixes a rejected invoke with its own words; the cause is what follows. */
export function newProjectFailure(failure: unknown): Error {
	const raw = failure instanceof Error ? failure.message : String(failure)
	const cause = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
	return new Error(`Couldn't create a new project: ${cause}`)
}
