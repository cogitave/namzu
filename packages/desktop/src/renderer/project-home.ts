import type { ProjectView } from '../shared/protocol.js'

export const DEFAULT_HOME_HEADING = 'What would you like to work on?'

/** The heading above an empty conversation: a real project names itself. */
export function projectHomeHeading(
	project: Pick<ProjectView, 'name' | 'palId' | 'isChat'> | undefined,
): string {
	if (!project || project.palId !== undefined || project.isChat) return DEFAULT_HOME_HEADING
	return `What should we work on in ${project.name}?`
}

/** The three ideas under an empty conversation: a project has files to explore, a plain chat does not. */
export function homeStarters(
	project: Pick<ProjectView, 'palId' | 'isChat'> | undefined,
): readonly [string, string, string] {
	if (!project || project.palId !== undefined || project.isChat)
		return ['Explain something', 'Draft a message', 'Plan a task']
	return ['Explore this project', 'Review a change', 'Plan a task']
}

/** Electron prefixes a rejected invoke with its own words; the cause is what follows. */
export function newProjectFailure(failure: unknown): Error {
	const raw = failure instanceof Error ? failure.message : String(failure)
	const cause = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
	return new Error(`Couldn't create a new project: ${cause}`)
}

/** Where a project made from scratch lives, said once when it is created. */
export function createdProjectNotice(project: Pick<ProjectView, 'name' | 'path'>): string {
	const parent = project.path.endsWith(project.name)
		? project.path.slice(0, project.path.length - project.name.length).replace(/[\\/]+$/, '')
		: project.path
	return `Created \u201c${project.name}\u201d in ${parent}.`
}
