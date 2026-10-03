import type { ProjectView } from '../shared/protocol.js'

/** A global New conversation never inherits a Pal's managed workspace. */
export function normalConversationProject(
	projects: readonly ProjectView[],
	currentId: string,
	previousId?: string,
): ProjectView | undefined {
	const available = projects.filter(
		(project) => !project.palId && project.trusted && project.status === 'ready',
	)
	return (
		available.find((project) => project.id === currentId) ??
		available.find((project) => project.id === previousId) ??
		available[0]
	)
}
