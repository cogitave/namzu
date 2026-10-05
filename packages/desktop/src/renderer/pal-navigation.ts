import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { compareConversationRecency } from './conversation-order.js'

/** Tracks whether a Pal conversation catalogue may have changed since its read. */
export class PalCatalogueActivity {
	private readonly revisions = new Map<string, number>()
	private readonly confirmed = new Map<string, number>()

	changed(palId: string): void {
		this.revisions.set(palId, (this.revisions.get(palId) ?? 0) + 1)
	}

	ticket(palId: string): number {
		return this.revisions.get(palId) ?? 0
	}

	confirm(palId: string, ticket: number): boolean {
		if (ticket !== this.ticket(palId)) return false
		this.confirmed.set(palId, ticket)
		return true
	}

	current(palId: string): boolean {
		return this.ticket(palId) === (this.confirmed.get(palId) ?? 0)
	}
}

/** Sidebar revisits use the same admitted, pane-owned route as its open tab. */
export function warmPalConversation(
	palId: string,
	projects: readonly ProjectView[],
	conversations: readonly ConversationView[],
	tabs: readonly string[],
	isAdmitted: (view: ConversationView) => boolean,
): ConversationView | undefined {
	const matching = projects.filter(
		(item) => item.palId === palId && item.trusted && item.status === 'ready',
	)
	if (matching.length !== 1) return
	const project = matching[0]
	if (!project) return
	const latest = conversations
		.filter((item) => item.palId === palId && item.projectId === project.id)
		.sort(compareConversationRecency)[0]
	// Do not substitute an older open tab for the latest conversation, adopt a
	// different pane's session, or revive a retired connection/choice admission.
	return latest && tabs.includes(latest.id) && isAdmitted(latest) ? latest : undefined
}
