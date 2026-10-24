import {
	DELIVERY_READ_LIMIT,
	type SourceConversationBinding,
	type SourceDelivery,
	type SourceDeliveryCursor,
	readSourceDeliveryPage,
} from '../../schedule/delivery.js'
import type { SchedulePaths } from '../../schedule/paths.js'
import { visibleScheduleMessage } from '../../schedule/visible-source.js'
import { explainFailure } from '../plain-failure.js'
import type { SystemLevel } from '../system-rows.js'

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

/** How a scheduled run ended, as the words that follow its name. */
const RUN_ENDINGS: Readonly<Record<SourceDelivery['status'], string>> = {
	completed: 'finished',
	failed: 'failed',
	'awaiting-approval': 'is waiting for your approval',
	'approval-expired': 'stopped waiting for approval',
	interrupted: 'was interrupted',
	'timed-out': 'timed out',
	'blocked-config': 'could not start because its settings need attention',
	cancelled: 'was stopped',
	'check-failed': 'failed its check',
}

/** How loudly a delivered run is drawn: a clean finish is quiet, a failure is red, the rest is yellow. */
export function deliveryLevel(status: SourceDelivery['status']): SystemLevel {
	switch (status) {
		case 'completed':
			return 'notice'
		case 'failed':
		case 'timed-out':
		case 'blocked-config':
		case 'check-failed':
			return 'error'
		default:
			return 'warning'
	}
}

/** The clock time of a run, in the reader's zone; empty when the stamp is unreadable. */
function clockAt(at: string): string {
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return ''
	const time = date.toLocaleTimeString('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
	})
	return ` at ${time}`
}

/**
 * One bounded display row; this text never enters the SDK conversation log.
 * `Scheduled job "nightly-build" failed at 09:12`, with the result and the
 * reason on the lines under it.
 */
export function sourceDeliveryLine(entry: SourceDelivery): string {
	return visibleScheduleMessage(
		[
			`Scheduled job "${entry.jobName}" ${RUN_ENDINGS[entry.status] ?? 'ended'}${clockAt(entry.at)}`,
			...(entry.summary ? [entry.summary] : []),
			...(entry.reason ? [entry.reason] : []),
		].join('\n'),
	)
}

export function sourceDeliveryReadError(error: unknown): string {
	return visibleScheduleMessage(
		`${explainFailure(error, 'Scheduled results could not be read.')} Unread results are kept for next time.`,
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
