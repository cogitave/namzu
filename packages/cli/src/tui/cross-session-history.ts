/**
 * What the terminal app does with the person's history when it starts, and on
 * every prompt sent from the box: the prompt history across conversations
 * (`history.jsonl`) and the removal of old conversations (`cleanupPeriodDays`).
 * Both run beside the start, never in front of it, and a failure of either
 * costs only what it was for.
 */

import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@namzu/sdk'
import {
	cleanupOldConversations,
	markCleanupNoticeShown,
	readCleanupPeriod,
} from '../integrations/sessions/cleanup.js'
import {
	type PastedRange,
	appendPromptHistory,
	loggedPromptsOf,
	pastedTextsOf,
	promptHistoryEnabled,
	promptHistoryEntryFor,
	promptHistorySkipped,
	readPromptHistory,
	recallPromptHistory,
	seedPromptHistory,
	trimPromptHistory,
} from '../integrations/sessions/prompt-history.js'
import { type CliSessions, readConversationFacts } from '../integrations/sessions/store.js'
import { isTrustedAtStateRoot } from '../integrations/trust/store.js'
import { homePath } from './person-terms.js'

export interface CrossSessionStart {
	readonly sessions: CliSessions
	/** The conversation this start opens. */
	readonly sessionId: string
	/** Set when the start resumes a conversation: its prompts are already in the box. */
	readonly resumed?: string
	/** When the app started; lines written from then on are this process's own. */
	readonly startedAt: number
}

const keepsByStart = new WeakMap<CliSessions, boolean>()

/**
 * Whether the box's prompts are written and recalled in this process, read once per start from the
 * settings of the home the conversations live in, not on every prompt sent.
 */
export function keepsPromptHistory(sessions: CliSessions): boolean {
	let answer = keepsByStart.get(sessions)
	if (answer === undefined) {
		answer = !promptHistorySkipped() && promptHistoryEnabled({ home: sessions.root })
		keepsByStart.set(sessions, answer)
	}
	return answer
}

/**
 * The project's earlier prompts for the box, oldest first. The first start in
 * a project from before the file existed seeds it from that project's newest
 * conversations; a file grown well past what it keeps is trimmed.
 */
export async function loadEarlierPrompts(start: CrossSessionStart): Promise<string[]> {
	const { sessions } = start
	if (!keepsPromptHistory(sessions)) return []
	try {
		await seedPromptHistory({
			home: sessions.root,
			project: sessions.projectRoot,
			projectDir: sessions.paths.projectDir(),
			conversations: async () =>
				(await sessions.index.listSessions({ slug: sessions.slug, rootsOnly: true }))
					.filter(
						(row) =>
							row.projectId === sessions.projectId &&
							row.id !== start.sessionId &&
							row.id !== start.resumed,
					)
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
					.map((row) => row.id),
			promptsOf: async (id) => {
				// The desktop app keeps its own conversations and does not use this file.
				const facts = await readConversationFacts(sessions, id, 'tolerant').catch(() => null)
				if (!facts || facts.started.origin?.protocol === 'desktop') return []
				return loggedPromptsOf(sessions, id)
			},
		})
	} catch {
		// A seed that fails leaves the file as it was; the next start tries again.
	}
	const recalled = await recallPromptHistory({
		home: sessions.root,
		project: sessions.projectRoot,
		before: start.startedAt,
		...(start.resumed ? { excludeSession: start.resumed } : {}),
		pastesOf: (id) => pastedTextsOf(sessions, id),
	})
	const { lines } = await readPromptHistory(sessions.root)
	await trimPromptHistory(sessions.root, lines)
	return recalled
}

/** Write one prompt sent from the box. Never throws and never waits on the box. */
export function recordSentPrompt(
	sessions: CliSessions | null,
	sessionId: string | undefined,
	text: string,
	pasted: readonly PastedRange[] | undefined,
): void {
	if (!sessions || !sessionId || !keepsPromptHistory(sessions)) return
	const entry = promptHistoryEntryFor({
		text,
		...(pasted?.length ? { pasted } : {}),
		project: sessions.projectRoot,
		sessionId,
		timestamp: Date.now(),
	})
	if (entry) void appendPromptHistory(sessions.root, entry)
}

/**
 * Mark a conversation just opened as in use: its folder's time is moved to
 * now, so another start's sweep never takes a conversation someone resumed
 * and has not written to yet.
 */
export async function touchOpenedConversation(
	sessions: CliSessions,
	sessionId: SessionId,
): Promise<void> {
	const now = new Date()
	await utimes(sessions.paths.sessionDir({ sessionId }), now, now).catch(() => undefined)
}

/**
 * Remove old conversations, at most once a day. When there is a sentence to
 * show once, `show` is called with it; it returns whether the sentence reached
 * the screen, and only then does the notice's grace week start.
 */
export async function cleanupOnStart(
	start: CrossSessionStart,
	show: (notice: string) => boolean,
): Promise<void> {
	const period = readCleanupPeriod({ home: start.sessions.root })
	const keep = new Set([start.sessionId, ...(start.resumed ? [start.resumed] : [])])
	const root = start.sessions.root
	const trusted = new Map<string, boolean>()
	const report = await cleanupOldConversations({
		home: root,
		periodDays: period?.periodDays,
		explicit: period?.explicit ?? false,
		keep,
		isTrusted: (cwd) => {
			let answer = trusted.get(cwd)
			if (answer === undefined) {
				answer = isTrustedAtStateRoot(cwd, root)
				trusted.set(cwd, answer)
			}
			return answer
		},
		settingsFile: homePath(join(root, 'config.yaml')),
	})
	if (report.notice && show(report.notice)) await markCleanupNoticeShown(root)
}
