/**
 * Conversation persistence for the TUI, built on the SDK's session
 * hierarchy (`DiskSessionStore`) — no parallel store. Each cwd is one
 * "project" (a `cli.json` pointer keeps its id stable across launches),
 * every conversation is a Session under a fixed CLI thread, and the
 * conversation's messages are appended to the session as turns complete.
 *
 * This is what powers `/resume`: list recent sessions, load a chosen
 * session's messages, and keep chatting in it. The session store roots at
 * `<cwd>/.namzu`, the same root `query()` writes its runs under, so a
 * session's `session.json` and its `runs/` live in one place.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	DiskSessionStore,
	type Message,
	type ProjectId,
	type SessionId,
	type TenantId,
	type ThreadId,
	UNKNOWN_TENANT_ID,
} from '@namzu/sdk'

const TENANT = UNKNOWN_TENANT_ID as TenantId
const THREAD = 'thd_namzu-cli' as ThreadId

export interface CliSessions {
	readonly store: DiskSessionStore
	readonly projectId: ProjectId
	readonly threadId: ThreadId
	readonly tenantId: TenantId
}

export interface RecentConversation {
	readonly id: SessionId
	readonly title: string
	readonly updatedAt: string
	readonly count: number
}

/**
 * Open (or initialize) the cwd's CLI project. Returns the handle used by
 * the other helpers. Throws only on unexpected store errors; callers treat
 * failures as "persistence unavailable" and run without it.
 */
export async function openSessions(cwd: string): Promise<CliSessions> {
	const root = join(cwd, '.namzu')
	const store = new DiskSessionStore({ rootDir: root })
	const pointerPath = join(root, 'cli.json')

	let projectId: ProjectId | undefined
	try {
		const ptr = JSON.parse(readFileSync(pointerPath, 'utf8')) as { projectId?: string }
		if (typeof ptr.projectId === 'string') projectId = ptr.projectId as ProjectId
	} catch {
		// no pointer yet
	}
	if (projectId && !(await store.getProject(projectId, TENANT))) {
		projectId = undefined // pointer is stale (dir wiped)
	}
	if (!projectId) {
		const project = await store.createProject({ tenantId: TENANT, name: 'namzu CLI' }, TENANT)
		projectId = project.id
		mkdirSync(root, { recursive: true })
		writeFileSync(pointerPath, `${JSON.stringify({ projectId }, null, 2)}\n`, { mode: 0o600 })
	}
	return { store, projectId, threadId: THREAD, tenantId: TENANT }
}

/** Start a fresh conversation; returns its session id. */
export async function startConversation(s: CliSessions): Promise<SessionId> {
	const session = await s.store.createSession(
		{ threadId: s.threadId, projectId: s.projectId, currentActor: null },
		s.tenantId,
	)
	return session.id
}

/** Append messages (in order) to a conversation. */
export async function appendMessages(
	s: CliSessions,
	sessionId: SessionId,
	messages: readonly Message[],
): Promise<void> {
	for (const m of messages) {
		await s.store.appendMessage(sessionId, m, s.tenantId)
	}
}

/** Load a conversation's full message history. */
export async function loadConversation(s: CliSessions, sessionId: SessionId): Promise<Message[]> {
	return [...(await s.store.loadMessages(sessionId, s.tenantId))]
}

/** Recent non-empty conversations, newest first — for the `/resume` list. */
export async function listRecent(s: CliSessions, limit = 20): Promise<RecentConversation[]> {
	const sessions = await s.store.listSessions(s.threadId, s.tenantId)
	const out: RecentConversation[] = []
	for (const sess of sessions) {
		const messages = await s.store.loadMessages(sess.id, s.tenantId)
		if (messages.length === 0) continue
		out.push({
			id: sess.id,
			title: conversationTitle(messages),
			updatedAt: toIso(sess.updatedAt),
			count: messages.length,
		})
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

function conversationTitle(messages: readonly Message[]): string {
	const firstUser = messages.find((m) => m.role === 'user')
	const raw = typeof firstUser?.content === 'string' ? firstUser.content : 'Conversation'
	const text = raw.replace(/\s+/g, ' ').trim()
	return text.length > 60 ? `${text.slice(0, 59)}…` : text || 'Conversation'
}

function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString()
	return typeof value === 'string' ? value : new Date(0).toISOString()
}
