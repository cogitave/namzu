/**
 * Deliver a detached run to the exact conversation that requested it.
 *
 * The SDK's `message` record belongs to a real turn. A scheduler result is
 * neither a user prompt nor a model answer in that conversation, so it lives
 * in a separate, immutable inbox instead of altering the model's transcript.
 * The TUI reads this inbox as host-owned status. Each event is published with
 * an exclusive link under the source session's writer lease: a retry after a
 * crash can find the same event, and an archive or turn cannot race the check.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
	DiskSessionLog,
	type SessionLease,
	SessionPaths,
	asSessionId,
	isEntityId,
} from '@namzu/sdk'
import { sanitizeLine } from '../integrations/notifications/desktop/sanitize.js'
import { readConversationFacts } from '../integrations/sessions/store.js'
import { readIdentity } from '../integrations/state/identity.js'
import type { SchedulePaths } from './paths.js'
import { publishExclusive, readVersioned } from './store/atomic.js'
import type { ScheduleJob, ScheduleRunResult, ScheduleRunStatus } from './types.js'

/** The exact installation, project and conversation named when a job was made. */
export interface SourceConversationBinding {
	readonly kind: 'source-conversation'
	readonly sessionId: string
	readonly projectSlug: string
	readonly projectId: string
	readonly tenantId: string
}

/** Host-owned status, never replayed as a model message. All free text is one bounded line. */
export interface SourceDelivery {
	readonly v: 1
	readonly kind: 'schedule-source-delivery'
	readonly source: SourceConversationBinding
	readonly jobId: string
	readonly jobName: string
	readonly runId: string
	readonly runSessionId?: string
	readonly status: Exclude<ScheduleRunStatus, 'running'>
	/** Stable time from the run result, not the delivery retry time. */
	readonly at: string
	/** Strictly increasing publication order within this source inbox; absent on older events. */
	readonly publishedOrder?: number
	readonly summary?: string
	readonly reason?: string
}

export type SourceDeliveryOutcome =
	| { readonly kind: 'delivered' | 'already-delivered' | 'quiet' }
	| { readonly kind: 'retry' | 'rejected'; readonly reason: string }

/** Enough room for a useful result while keeping one inbox entry small. */
export const DELIVERY_SUMMARY_CHARS = 600
export const DELIVERY_REASON_CHARS = 300
export const DELIVERY_READ_LIMIT = 100

export interface SourceDeliveryCursor {
	readonly order: number
	readonly file: string
}

export interface SourceDeliveryPage {
	readonly entries: readonly SourceDelivery[]
	readonly cursor?: SourceDeliveryCursor
	readonly hasMore: boolean
}

const UUID =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const FINAL_STATUSES: ReadonlySet<string> = new Set([
	'completed',
	'failed',
	'awaiting-approval',
	'approval-expired',
	'interrupted',
	'timed-out',
	'blocked-config',
	'cancelled',
	'check-failed',
])

function id(value: string): boolean {
	return UUID.test(value)
}

function sourcePaths(paths: SchedulePaths, source: SourceConversationBinding): SessionPaths {
	return new SessionPaths({ home: paths.home, slug: source.projectSlug })
}

function deliveryDir(paths: SchedulePaths, source: SourceConversationBinding): string {
	if (!isEntityId(source.sessionId, 'session')) throw new Error('invalid source session id')
	return join(paths.root, 'deliveries', source.sessionId)
}

function eventKey(delivery: Pick<SourceDelivery, 'jobId' | 'runId' | 'status' | 'at'>): string {
	return createHash('sha256')
		.update(JSON.stringify([delivery.jobId, delivery.runId, delivery.status, delivery.at]))
		.digest('hex')
}

function eventFile(paths: SchedulePaths, delivery: SourceDelivery): string {
	return join(deliveryDir(paths, delivery.source), `${eventKey(delivery)}.json`)
}

function sameSource(a: SourceConversationBinding, b: SourceConversationBinding): boolean {
	return (
		a.kind === b.kind &&
		a.sessionId === b.sessionId &&
		a.projectSlug === b.projectSlug &&
		a.projectId === b.projectId &&
		a.tenantId === b.tenantId
	)
}

/** Validate every durable coordinate before any inbox write or UI read. */
async function sourceProblem(
	paths: SchedulePaths,
	source: SourceConversationBinding,
): Promise<string | undefined> {
	if (
		source.kind !== 'source-conversation' ||
		!isEntityId(source.sessionId, 'session') ||
		!isEntityId(source.projectId, 'project') ||
		!isEntityId(source.tenantId, 'tenant')
	)
		return 'the source conversation binding is invalid'
	let sessionPaths: SessionPaths
	try {
		sessionPaths = sourcePaths(paths, source)
	} catch {
		return 'the source project slug is invalid'
	}
	const identity = readIdentity(paths.home)
	if (!identity || identity.tenantId !== source.tenantId)
		return 'the source conversation belongs to another installation'
	let project: unknown
	try {
		project = JSON.parse(readFileSync(sessionPaths.projectFile(), 'utf8'))
	} catch {
		return 'the source project is missing or unreadable'
	}
	if (
		!project ||
		typeof project !== 'object' ||
		(project as { projectId?: unknown }).projectId !== source.projectId ||
		(project as { slug?: unknown }).slug !== source.projectSlug
	)
		return 'the source project no longer matches its binding'
	const facts = await readConversationFacts({ paths: sessionPaths }, asSessionId(source.sessionId))
	if (!facts) return 'the source conversation is missing'
	if (
		facts.started.projectId !== source.projectId ||
		// Legacy session_started records had no tenant. The installation identity
		// and exact project were already checked above; an explicit different
		// tenant in the log still rejects the binding.
		(facts.started.tenantId !== undefined && facts.started.tenantId !== source.tenantId) ||
		facts.started.cwd !== (project as { cwd?: unknown }).cwd
	)
		return 'the source conversation no longer matches its binding'
	if (facts.archived) return 'the source conversation is archived'
	return undefined
}

function scriptSummary(result: ScheduleRunResult): string {
	const stdout = result.scriptOutput?.stdout
	if (!stdout) return ''
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string
		// The wake gate's JSON is a control result, not a finding to deliver.
		if (!(line.startsWith('{') && line.endsWith('}'))) return line
	}
	return ''
}

function deliveryFor(job: ScheduleJob, result: ScheduleRunResult): SourceDelivery | undefined {
	const source = job.delivery
	if (
		!source ||
		result.status === 'running' ||
		(result.status === 'completed' && result.scriptReport?.state === 'quiet') ||
		(result.status === 'completed' && result.gateResult?.wake === false)
	)
		return undefined
	const summary = sanitizeLine(
		result.summary || result.scriptReport?.summary || scriptSummary(result),
		DELIVERY_SUMMARY_CHARS,
	)
	const calls = result.refusedCalls ?? result.failedCalls
	const callNote = calls
		? `${calls.count} ${result.refusedCalls ? 'refused' : 'failed'} call${calls.count === 1 ? '' : 's'}; first: ${calls.first.tool}: ${calls.first.reason}`
		: ''
	const reason = sanitizeLine(result.reason ?? callNote, DELIVERY_REASON_CHARS)
	const noteworthy =
		result.status !== 'completed' ||
		Boolean(summary || reason || result.refusedCalls || result.failedCalls)
	if (!noteworthy) return undefined
	const at = result.endedAt ?? result.startedAt
	return {
		v: 1,
		kind: 'schedule-source-delivery',
		source: { ...source },
		jobId: job.id,
		jobName: sanitizeLine(job.name, 80),
		runId: result.runId,
		...(result.sessionId ? { runSessionId: result.sessionId } : {}),
		status: result.status,
		at,
		...(summary ? { summary } : {}),
		...(reason ? { reason } : {}),
	}
}

function validDelivery(value: SourceDelivery, source: SourceConversationBinding): boolean {
	return (
		value.v === 1 &&
		value.kind === 'schedule-source-delivery' &&
		value.source !== null &&
		typeof value.source === 'object' &&
		sameSource(value.source, source) &&
		id(value.jobId) &&
		id(value.runId) &&
		typeof value.jobName === 'string' &&
		[...value.jobName].length <= 80 &&
		FINAL_STATUSES.has(value.status) &&
		Number.isFinite(Date.parse(value.at)) &&
		(value.publishedOrder === undefined ||
			(Number.isSafeInteger(value.publishedOrder) && value.publishedOrder >= 0)) &&
		(value.runSessionId === undefined || isEntityId(value.runSessionId, 'session')) &&
		(value.summary === undefined ||
			(typeof value.summary === 'string' && [...value.summary].length <= DELIVERY_SUMMARY_CHARS)) &&
		(value.reason === undefined ||
			(typeof value.reason === 'string' && [...value.reason].length <= DELIVERY_REASON_CHARS))
	)
}

interface InboxRecord {
	readonly entry: SourceDelivery
	readonly name: string
	readonly order: number
}

function inboxFiles(
	paths: SchedulePaths,
	source: SourceConversationBinding,
): { readonly dir: string; readonly names: readonly string[] } {
	const dir = deliveryDir(paths, source)
	try {
		return {
			dir,
			names: readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)),
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dir, names: [] }
		throw error
	}
}

/** Read immutable inbox records; legacy files use their creation time for order. */
function inboxRecords(paths: SchedulePaths, source: SourceConversationBinding): InboxRecord[] {
	const { dir, names } = inboxFiles(paths, source)
	return names.map((name) => {
		const file = join(dir, name)
		const entry = readVersioned<SourceDelivery>(file, 'schedule-source-delivery', 1)
		if (!entry || !validDelivery(entry, source) || `${eventKey(entry)}.json` !== name)
			throw new Error(`${file} is not a delivery for this source conversation`)
		const age = entry.publishedOrder === undefined ? statSync(file) : undefined
		const order =
			entry.publishedOrder ?? (age && age.birthtimeMs > 0 ? age.birthtimeMs : (age?.mtimeMs ?? 0))
		return { entry, name, order }
	})
}

function compareRecord(a: Pick<InboxRecord, 'order' | 'name'>, b: SourceDeliveryCursor): number {
	return a.order - b.order || a.name.localeCompare(b.file)
}

/** The source lease serializes writers, including clocks that move backwards. */
function nextPublicationOrder(paths: SchedulePaths, source: SourceConversationBinding): number {
	const { dir, names } = inboxFiles(paths, source)
	let latest = 0
	for (const name of names) {
		const file = join(dir, name)
		const age = statSync(file)
		let order = age.birthtimeMs > 0 ? age.birthtimeMs : age.mtimeMs
		// A damaged prior event stays in place for repair and fails strict UI
		// reads. It must not prevent a different run from being published.
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(file, 'utf8'))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code) throw error
		}
		try {
			const entry = parsed as SourceDelivery
			if (
				entry &&
				validDelivery(entry, source) &&
				`${eventKey(entry)}.json` === name &&
				entry.publishedOrder !== undefined
			)
				order = entry.publishedOrder
		} catch {
			// The strict reader reports malformed records to the TUI.
		}
		latest = Math.max(latest, order)
	}
	const next = Math.max(Date.now(), Math.floor(latest) + 1)
	if (!Number.isSafeInteger(next)) throw new Error('source delivery publication order is exhausted')
	return next
}

/**
 * Publish one result without ever creating a source conversation. A held
 * source lease means its turn is running; the daemon should retry later.
 */
export async function deliverRunToSource(
	paths: SchedulePaths,
	job: ScheduleJob,
	result: ScheduleRunResult,
): Promise<SourceDeliveryOutcome> {
	if (!job.delivery) return { kind: 'quiet' }
	if (result.jobId !== job.id || !id(job.id) || !id(result.runId))
		return { kind: 'rejected', reason: 'the run does not match its source job' }
	const delivery = deliveryFor(job, result)
	if (!delivery) return { kind: 'quiet' }
	if (!Number.isFinite(Date.parse(delivery.at)))
		return { kind: 'rejected', reason: 'the run result has no valid time' }
	// A crash may happen after exclusive publication but before the daemon
	// commits this run's script checkpoint. The source might be archived in
	// between. An already-published, valid event remains delivered; requiring
	// the source to be writable again would strand the checkpoint forever.
	let file: string
	try {
		file = eventFile(paths, delivery)
		const existing = readVersioned<SourceDelivery>(file, 'schedule-source-delivery', 1)
		if (existing) {
			return validDelivery(existing, job.delivery) && eventKey(existing) === eventKey(delivery)
				? { kind: 'already-delivered' }
				: { kind: 'rejected', reason: 'a different delivery already owns this run event' }
		}
	} catch (error) {
		return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) }
	}
	let sessionPaths: SessionPaths
	try {
		sessionPaths = sourcePaths(paths, job.delivery)
		const problem = await sourceProblem(paths, job.delivery)
		if (problem) return { kind: 'rejected', reason: problem }
	} catch (error) {
		return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) }
	}
	const log = DiskSessionLog.at(sessionPaths, { sessionId: asSessionId(job.delivery.sessionId) })
	let lease: SessionLease | null
	try {
		lease = await log.claim({
			holder: `namzu-schedule-delivery:${process.pid}:${randomUUID()}`,
			ttlMs: 30_000,
			repairTornTail: false,
		})
	} catch (error) {
		return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) }
	}
	if (!lease) return { kind: 'retry', reason: 'the source conversation is busy' }
	try {
		const problem = await sourceProblem(paths, job.delivery)
		if (problem) return { kind: 'rejected', reason: problem }
		const published = {
			...delivery,
			publishedOrder: nextPublicationOrder(paths, job.delivery),
		}
		// A large log may take long to verify. Renew at the publication boundary;
		// the inbox scan may also take time. If the fence changed, another
		// writer could have archived the source or allocated the next order.
		const renewed = await log.claim({
			holder: lease.holder,
			ttlMs: 30_000,
			repairTornTail: false,
		})
		if (!renewed || renewed.fence !== lease.fence)
			return { kind: 'retry', reason: 'the source conversation lease changed' }
		if (!publishExclusive(file, published)) {
			const existing = readVersioned<SourceDelivery>(file, 'schedule-source-delivery', 1)
			if (
				!existing ||
				!validDelivery(existing, job.delivery) ||
				eventKey(existing) !== eventKey(delivery)
			)
				return { kind: 'rejected', reason: 'a different delivery already owns this run event' }
			return { kind: 'already-delivered' }
		}
		return { kind: 'delivered' }
	} catch (error) {
		return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) }
	} finally {
		await log.release(lease)
	}
}

/** Read the next bounded page by publication order, including delayed old runs. */
export async function readSourceDeliveryPage(
	paths: SchedulePaths,
	source: SourceConversationBinding,
	after?: SourceDeliveryCursor,
): Promise<SourceDeliveryPage> {
	const problem = await sourceProblem(paths, source)
	if (problem) throw new Error(problem)
	const records = inboxRecords(paths, source)
		.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
		.filter((record) => after === undefined || compareRecord(record, after) > 0)
	const page = records.slice(0, DELIVERY_READ_LIMIT)
	const last = page.at(-1)
	return {
		entries: page.map((record) => record.entry),
		...(last ? { cursor: { order: last.order, file: last.name } } : after ? { cursor: after } : {}),
		hasMore: records.length > DELIVERY_READ_LIMIT,
	}
}

/** Latest bounded view in publication order. Use pages to drain every unread event. */
export async function readSourceDeliveries(
	paths: SchedulePaths,
	source: SourceConversationBinding,
): Promise<readonly SourceDelivery[]> {
	const problem = await sourceProblem(paths, source)
	if (problem) throw new Error(problem)
	return inboxRecords(paths, source)
		.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
		.slice(-DELIVERY_READ_LIMIT)
		.map((record) => record.entry)
}
