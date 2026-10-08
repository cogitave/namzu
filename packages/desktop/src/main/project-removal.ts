import type { ProjectUntrust } from '../shared/protocol.js'
import type { DesktopConversationSnapshot } from './desktop-conversation-store.js'

/** The slice of a live conversation that decides whether its project may be taken away. */
export interface RemovalProbe {
	running: boolean
	admitting?: unknown
	queue: readonly unknown[]
	permissions: { size: number }
	reattaching?: unknown
	selectionPending?: unknown
}

/** Plain-language reason a project cannot be removed right now, or undefined when it can. */
export function projectBusyReason(
	projectName: string,
	conversations: Iterable<RemovalProbe & { view: { id: string } }>,
	changingPlugins: { has(id: string): boolean },
): string | undefined {
	for (const item of conversations) {
		if (item.running || item.admitting || item.queue.length || item.permissions.size)
			return `A reply is still running in ${projectName}. Stop it or wait for it to finish, then remove the project.`
		if (item.reattaching || item.selectionPending || changingPlugins.has(item.view.id))
			return `${projectName} is still changing. Wait a moment, then remove the project.`
	}
	return undefined
}

/** The host's answer to `namzu/project/untrust`, reduced to what a person is told. */
export function parseUntrust(result: unknown): ProjectUntrust {
	if (!result || typeof result !== 'object') throw new Error('Namzu returned an invalid answer.')
	const value = result as { removed?: unknown; trusted?: unknown; stillTrustedBy?: unknown }
	if (typeof value.removed !== 'boolean' || typeof value.trusted !== 'boolean')
		throw new Error('Namzu returned an invalid answer.')
	if (value.trusted) {
		const by = typeof value.stillTrustedBy === 'string' ? value.stillTrustedBy : ''
		return { state: 'still-trusted', by: by.slice(0, 4096) }
	}
	return { state: 'removed' }
}

/** Forget a project in the saved desktop state: its row, its conversations, its drafts. */
export function withoutProject(
	snapshot: DesktopConversationSnapshot,
	projectId: string,
	isProjectDraft: (ownerId: string) => boolean,
	retiredOwners: ReadonlySet<string>,
): DesktopConversationSnapshot {
	return {
		...snapshot,
		projects: snapshot.projects.filter((item) => item.id !== projectId),
		conversations: snapshot.conversations.filter((item) => item.view.projectId !== projectId),
		projectDrafts: snapshot.projectDrafts.filter((item) => !isProjectDraft(item.ownerId)),
		attachments: snapshot.attachments.filter((item) => !retiredOwners.has(item.ownerId)),
	}
}
