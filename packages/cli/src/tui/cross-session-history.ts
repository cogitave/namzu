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
import { cleanupOldConversations, readCleanupPeriod } from '../integrations/sessions/cleanup.js'
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
import type { CliSessions } from '../integrations/sessions/store.js'
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

/** Whether the box's prompts are written and recalled in this process. */
export function keepsPromptHistory(): boolean {
	return !promptHistorySkipped() && promptHistoryEnabled()
}

/**
 * The project's earlier prompts for the box, oldest first. The first start in
 * a project from before the file existed seeds it from that project's newest
 * conversations; a file grown well past what it keeps is trimmed.
 */
export async function loadEarlierPrompts(start: CrossSessionStart): Promise<string[]> {
	if (!keepsPromptHistory()) return []
	const { sessions } = start
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
			promptsOf: (id) => loggedPromptsOf(sessions, id),
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
	if (!sessions || !sessionId || !keepsPromptHistory()) return
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
 * Remove old conversations, at most once a day. Resolves to the sentence to
 * show once, when there is one.
 */
export async function cleanupOnStart(start: CrossSessionStart): Promise<string | undefined> {
	const period = readCleanupPeriod()
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
	return report.notice
}
