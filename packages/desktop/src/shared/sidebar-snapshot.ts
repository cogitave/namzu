import type { PalAppearance } from '@namzu/sdk'
import type { ConversationView } from './protocol.js'

/**
 * What the sidebar needs to draw its first frame exactly as it was when the app last closed.
 * It is a picture, not a record: the live reads replace every row in place, and nothing that
 * decides whether a conversation or a tab exists may read it.
 */
export interface SidebarSnapshot {
	v: 1
	pals: SidebarPalRow[]
	/** The rows the sidebar listed, newest first, with no message content. */
	conversations: SidebarConversationRow[]
	/** Projects whose conversations were open in the list. */
	expandedProjects: string[]
	/** Archived conversations, for the entry that lists them. */
	archivedCount?: number
}
export interface SidebarPalRow {
	id: string
	name: string
	appearance?: PalAppearance
	paused: boolean
}
export type SidebarConversationRow = Pick<
	ConversationView,
	'id' | 'projectId' | 'title' | 'updatedAt' | 'palId' | 'harness' | 'pinned'
>

export const SIDEBAR_SNAPSHOT_PALS = 50
/** Enough for every list the sidebar shows; the live read brings the rest. */
export const SIDEBAR_SNAPSHOT_CONVERSATIONS = 240
export const SIDEBAR_SNAPSHOT_PER_PROJECT = 12
const EXPANDED_LIMIT = 100
const TEXT_LIMIT = 400
const CHARACTERS = ['pixel', 'sprout', 'spark'] as const
const COLORS = ['green', 'blue', 'amber', 'violet', 'rose'] as const
const HARNESSES = ['namzu', 'codex-cli', 'claude-code'] as const

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length > 0 && value.length <= TEXT_LIMIT ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

function palRow(value: unknown): SidebarPalRow | undefined {
	const item = record(value)
	const id = text(item?.id)
	const name = text(item?.name)
	if (!item || !id || !name) return undefined
	const look = record(item.appearance)
	const appearance =
		look &&
		(CHARACTERS as readonly unknown[]).includes(look.character) &&
		(COLORS as readonly unknown[]).includes(look.color)
			? ({ character: look.character, color: look.color } as PalAppearance)
			: undefined
	return { id, name, ...(appearance ? { appearance } : {}), paused: item.paused === true }
}

function conversationRow(value: unknown): SidebarConversationRow | undefined {
	const item = record(value)
	const id = text(item?.id)
	const projectId = text(item?.projectId)
	const updatedAt = text(item?.updatedAt)
	if (!item || !id || !projectId || !updatedAt || typeof item.title !== 'string') return undefined
	const palId = text(item.palId)
	const harness = (HARNESSES as readonly unknown[]).includes(item.harness)
		? (item.harness as NonNullable<ConversationView['harness']>)
		: undefined
	return {
		id,
		projectId,
		title: item.title.slice(0, TEXT_LIMIT),
		updatedAt,
		...(palId ? { palId } : {}),
		...(harness ? { harness } : {}),
		...(item.pinned === true ? { pinned: true as const } : {}),
	}
}

/** A snapshot read back from disk or from the page; anything unusable is dropped, never thrown. */
export function readSidebarSnapshot(value: unknown): SidebarSnapshot | undefined {
	const input = record(value)
	if (!input || input.v !== 1) return undefined
	const list = (key: string): unknown[] =>
		Array.isArray(input[key]) ? (input[key] as unknown[]) : []
	const seen = new Set<string>()
	const conversations: SidebarConversationRow[] = []
	for (const item of list('conversations')) {
		if (conversations.length >= SIDEBAR_SNAPSHOT_CONVERSATIONS) break
		const row = conversationRow(item)
		if (!row || seen.has(row.id)) continue
		seen.add(row.id)
		conversations.push(row)
	}
	const pals = list('pals')
		.slice(0, SIDEBAR_SNAPSHOT_PALS)
		.flatMap((item) => palRow(item) ?? [])
	const expandedProjects = [
		...new Set(
			list('expandedProjects')
				.slice(0, EXPANDED_LIMIT)
				.flatMap((item) => text(item) ?? []),
		),
	]
	const archivedCount =
		typeof input.archivedCount === 'number' &&
		Number.isSafeInteger(input.archivedCount) &&
		input.archivedCount >= 0
			? input.archivedCount
			: undefined
	return {
		v: 1,
		pals,
		conversations,
		expandedProjects,
		...(archivedCount !== undefined ? { archivedCount } : {}),
	}
}
