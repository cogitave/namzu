import type { ConversationView, ProjectView } from '../shared/protocol.js'

export interface ConversationTabsState {
	projectId: string
	activeSessionId: string
	openTabIds: string[]
}

export const CONVERSATION_TABS_STORAGE_KEY = 'namzu.conversation-tabs'

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function validated(value: unknown): ConversationTabsState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return
	const state = value as Record<string, unknown>
	if (
		Object.keys(state).some(
			(key) => !['projectId', 'activeSessionId', 'openTabIds'].includes(key),
		) ||
		!validId(state.projectId) ||
		!(state.activeSessionId === '' || validId(state.activeSessionId)) ||
		!Array.isArray(state.openTabIds) ||
		!state.openTabIds.every(validId)
	)
		return
	return {
		projectId: state.projectId,
		activeSessionId: state.activeSessionId,
		openTabIds: [...state.openTabIds],
	}
}

export function readConversationTabsState(
	storage: Pick<Storage, 'getItem'>,
): ConversationTabsState | undefined {
	try {
		const raw = storage.getItem(CONVERSATION_TABS_STORAGE_KEY)
		return raw === null ? undefined : validated(JSON.parse(raw))
	} catch {
		return undefined
	}
}

/** Stores navigation identity only; main remains the owner of drafts and settings. */
export function writeConversationTabsState(
	storage: Pick<Storage, 'setItem'>,
	value: ConversationTabsState,
): boolean {
	try {
		const state = validated(value)
		if (!state) return false
		storage.setItem(CONVERSATION_TABS_STORAGE_KEY, JSON.stringify(state))
		return true
	} catch {
		return false
	}
}

export function resolveConversationTabsState(
	value: ConversationTabsState,
	projects: readonly ProjectView[],
	conversations: readonly ConversationView[],
): ConversationTabsState | undefined {
	const state = validated(value)
	if (!state) return
	const normalProjects = new Set(
		projects.filter((project) => project.palId === undefined).map((project) => project.id),
	)
	if (!normalProjects.has(state.projectId)) return
	const normalConversations = new Map(
		conversations
			.filter(
				(conversation) =>
					conversation.palId === undefined && normalProjects.has(conversation.projectId),
			)
			.map((conversation) => [conversation.id, conversation]),
	)
	const openTabIds = [...new Set(state.openTabIds)].filter((id) => normalConversations.has(id))
	if (state.activeSessionId) {
		const active = normalConversations.get(state.activeSessionId)
		if (!active || active.projectId !== state.projectId || !openTabIds.includes(active.id)) return
	}
	return { projectId: state.projectId, activeSessionId: state.activeSessionId, openTabIds }
}
