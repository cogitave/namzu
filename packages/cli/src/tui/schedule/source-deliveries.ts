/** Host-owned scheduled results for the conversation currently on screen. */

import { sanitizeLine } from '../../integrations/notifications/desktop/sanitize.js'
import {
	DELIVERY_READ_LIMIT,
	type SourceConversationBinding,
	type SourceDelivery,
	type SourceDeliveryCursor,
	readSourceDeliveryPage,
} from '../../schedule/delivery.js'
import type { SchedulePaths } from '../../schedule/paths.js'
import { visibleScheduleMessage } from '../../schedule/visible-source.js'

interface SourceSession {
	readonly slug: string
	readonly projectId: string
	readonly tenantId: string
}

interface SourceScope {
	readonly sessionId: string
	readonly projectId: string
	readonly tenantId: string
}

/** The binding comes from the active persisted scope, never a tool argument. */
export function sourceConversationBinding(
	sessions: SourceSession | null,
	scope: SourceScope | null,
	materialized: boolean,
): SourceConversationBinding | undefined {
	if (!materialized || !sessions || !scope) return undefined
	if (
		![sessions.slug, sessions.projectId, sessions.tenantId, scope.sessionId].every(
			(value) => typeof value === 'string' && value.length > 0,
		)
	)
		return undefined
	if (sessions.projectId !== scope.projectId || sessions.tenantId !== scope.tenantId)
		return undefined
	return {
		kind: 'source-conversation',
		sessionId: scope.sessionId,
		projectSlug: sessions.slug,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
	}
}

function deliveryKey(entry: SourceDelivery): string {
	return JSON.stringify([entry.jobId, entry.runId, entry.status, entry.at])
}

/** One bounded display row; this text never enters the SDK conversation log. */
export function sourceDeliveryLine(entry: SourceDelivery): string {
	return visibleScheduleMessage(
		[
			`Scheduled: ${entry.jobName} · ${entry.status} · ${entry.at}`,
			...(entry.summary ? [`Result: ${entry.summary}`] : []),
			...(entry.reason ? [`Reason: ${entry.reason}`] : []),
			...(entry.runSessionId ? [`Run conversation: ${entry.runSessionId}`] : []),
		].join('\n'),
	)
}

export function sourceDeliveryReadError(error: unknown): string {
	const reason = sanitizeLine(error instanceof Error ? error.message : String(error), 300)
	return visibleScheduleMessage(
		`Scheduled results could not be read: ${reason || 'unknown error'}. Unread results remain in the source inbox under NAMZU_HOME.`,
	)
}

/**
 * One reader per TUI. A conversation switch resets the display set; a slow
 * read from the previous transcript cannot publish into the new one.
 */
export class SourceDeliveryView {
	private viewKey: string | undefined
	private generation = 0
	private readingGeneration: number | undefined
	private readonly seen = new Set<string>()
	private readonly recent: string[] = []
	private cursor: SourceDeliveryCursor | undefined
	private more = false

	constructor(private readonly read: typeof readSourceDeliveryPage = readSourceDeliveryPage) {}

	reset(): void {
		this.viewKey = undefined
		this.generation++
		this.seen.clear()
		this.recent.length = 0
		this.cursor = undefined
		this.more = false
	}

	get hasMore(): boolean {
		return this.more
	}

	async poll(
		paths: SchedulePaths,
		source: SourceConversationBinding,
		transcriptGeneration: number,
	): Promise<readonly SourceDelivery[]> {
		const viewKey = JSON.stringify([
			paths.home,
			transcriptGeneration,
			source.sessionId,
			source.projectSlug,
			source.projectId,
			source.tenantId,
		])
		if (viewKey !== this.viewKey) {
			this.reset()
			this.viewKey = viewKey
		}
		const generation = this.generation
		if (this.readingGeneration === generation) return []
		this.readingGeneration = generation
		try {
			const page = await this.read(paths, source, this.cursor)
			if (generation !== this.generation) return []
			this.cursor = page.cursor
			this.more = page.hasMore
			return page.entries.filter((entry) => {
				const key = deliveryKey(entry)
				if (this.seen.has(key)) return false
				this.seen.add(key)
				this.recent.push(key)
				if (this.recent.length > DELIVERY_READ_LIMIT * 2)
					this.seen.delete(this.recent.shift() as string)
				return true
			})
		} finally {
			if (this.readingGeneration === generation) this.readingGeneration = undefined
		}
	}
}
