/** Pal conversation membership is recorded in the session log's first record. */
import {
	type PalConversationGreeting,
	type SessionId,
	asSessionId,
	generateSessionId,
	isEntityId,
	palConversationGreeting,
} from '@namzu/sdk'
import {
	type CliSessions,
	type ConversationFacts,
	type RecentConversation,
	closeSessions,
	conversationTitle,
	loadConversation,
	openSessions,
	readConversationFacts,
	startConversation,
} from '../integrations/sessions/store.js'
import { type Pal, getPal, getPalRevision, palAtWorkspace } from './store.js'

const MARK = 'namzu-pal'

export interface PalConversationBinding {
	readonly pal: Pal
	readonly definition: Pal
	readonly sessionId: SessionId
}

function tag(palId: string, revision: number, sessionId: string): string {
	return JSON.stringify([MARK, palId, revision, sessionId])
}
function parseTag(value: unknown, sessionId: string): { id: string; revision: number } | null {
	if (typeof value !== 'string') return null
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 4 ||
		parsed[0] !== MARK ||
		typeof parsed[1] !== 'string' ||
		!Number.isSafeInteger(parsed[2]) ||
		parsed[2] < 1 ||
		parsed[3] !== sessionId
	)
		return null
	return { id: parsed[1], revision: parsed[2] }
}

/** A Pal-origin log must also match the workspace's real project and tenant. */
export async function palConversationBinding(
	cwd: string,
	sessionId: string,
): Promise<PalConversationBinding | null> {
	const pal = palAtWorkspace(cwd)
	if (!pal) return null
	if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
	const state = await openSessions(cwd)
	try {
		return (await readPalConversation(state, cwd, pal.id, sessionId))?.binding ?? null
	} finally {
		closeSessions(state)
	}
}

/** Reuse the authenticated scope, while reading each candidate's ownership from its actual log. */
async function readPalConversation(
	state: CliSessions,
	cwd: string,
	palId: string,
	sessionId: string,
): Promise<{ binding: PalConversationBinding; facts: ConversationFacts } | null> {
	if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
	const facts = await readConversationFacts(state, asSessionId(sessionId))
	// Recheck the live profile and canonical directory after the asynchronous log read.
	const pal = palAtWorkspace(cwd, state.root)
	if (!pal) return null
	if (pal.id !== palId || pal.workspace !== state.projectRoot)
		throw new Error('This Pal does not own the current workspace.')
	const origin = facts?.started.origin
	const owner =
		origin?.protocol === 'desktop' ? parseTag(origin.externalSessionId, sessionId) : null
	if (
		!facts ||
		!owner ||
		owner.id !== pal.id ||
		facts.started.projectId !== state.projectId ||
		facts.started.tenantId !== state.tenantId ||
		facts.started.cwd !== pal.workspace
	)
		throw new Error('This conversation is not claimed by this Pal.')
	const definition = getPalRevision(pal.id, owner.revision, state.root)
	if (definition.workspace !== pal.workspace) throw new Error('Pal workspace identity changed.')
	return { binding: { pal, definition, sessionId: asSessionId(sessionId) }, facts }
}

/** Bind an ACP-created, never-started wire session to this Pal and definition revision. */
export async function claimPalConversation(
	cwd: string,
	palId: string,
	sessionId: string,
	pinnedRevision?: number,
): Promise<{
	sessionId: string
	palId: string
	revision: number
	palGreeting: PalConversationGreeting
}> {
	const pal = getPal(palId)
	if (!pal || pal.workspace !== cwd || palAtWorkspace(cwd)?.id !== palId)
		throw new Error('This Pal does not own the current workspace.')
	if (pal.paused) throw new Error('This Pal is paused.')
	if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
	const definition = getPalRevision(palId, pinnedRevision ?? pal.revision)
	if (definition.workspace !== cwd) throw new Error('Pal workspace identity changed.')
	const state = await openSessions(cwd)
	try {
		const existing = await readConversationFacts(state, asSessionId(sessionId))
		if (existing) {
			const binding = await palConversationBinding(cwd, sessionId)
			if (!binding || binding.pal.id !== palId)
				throw new Error('This conversation is not claimed by this Pal.')
			if (pinnedRevision !== undefined && binding.definition.revision !== pinnedRevision)
				throw new Error('This conversation belongs to another Pal profile revision.')
			return {
				sessionId,
				palId,
				revision: binding.definition.revision,
				palGreeting: palConversationGreeting(binding.definition, sessionId),
			}
		}
		await startConversation(state, {
			id: asSessionId(sessionId),
			origin: {
				protocol: 'desktop',
				externalSessionId: tag(pal.id, definition.revision, sessionId),
			},
		})
		return {
			sessionId,
			palId,
			revision: definition.revision,
			palGreeting: palConversationGreeting(definition, sessionId),
		}
	} finally {
		closeSessions(state)
	}
}

/** Only Pal-claimed root logs are listed, even if another CLI used its workspace. */
export async function listPalConversations(
	cwd: string,
	palId: string,
): Promise<
	(RecentConversation & {
		readonly hasPrompted: boolean
		readonly palGreeting: PalConversationGreeting
	})[]
> {
	const pal = palAtWorkspace(cwd)
	if (!pal || pal.id !== palId) throw new Error('This Pal does not own the current workspace.')
	const state = await openSessions(cwd)
	try {
		// Membership is validated before the output limit; unrelated logs cannot hide owned sessions.
		const rows = (
			await state.index.listSessions({ slug: state.slug, rootsOnly: true, includeArchived: false })
		)
			.filter((row) => row.projectId === state.projectId && !row.archived)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		const owned: Awaited<ReturnType<typeof listPalConversations>> = []
		for (const row of rows) {
			try {
				const candidate = await readPalConversation(state, cwd, palId, row.id)
				if (!candidate || candidate.facts.archived) continue
				const { binding, facts } = candidate
				const messages = await loadConversation(state, row.id)
				owned.push({
					id: row.id,
					title:
						facts.title ??
						row.title ??
						(messages.length ? conversationTitle(messages) : 'New conversation'),
					updatedAt: facts.updatedAt,
					named: facts.named,
					count: messages.length,
					hasPrompted: messages.length > 0,
					palGreeting: palConversationGreeting(binding.definition, row.id),
				})
				if (owned.length === 100) break
			} catch {
				// Unclaimed, foreign or invalid records grant no Pal membership.
			}
		}
		return owned
	} finally {
		closeSessions(state)
	}
}

/** Helpers for callers that need a fresh id without creating a second ACP slot. */
export function newPalSessionId(): SessionId {
	return generateSessionId()
}
