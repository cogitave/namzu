import { appendFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId, SessionPaths } from '@namzu/sdk'

const MAX_READ_BYTES = 256 * 1024
const MAX_CONTEXT_CHARACTERS = 32_000
export interface ChildOperatorNotice {
	readonly id: string
	readonly text: string
}

/** The live receipt and its durable observation describe the same admission. */
export function formatChildOperatorAdmission(input: {
	readonly id: string
	readonly viewId: string
	readonly taskId: string
	readonly message: string
	readonly kind: 'queued' | 'started'
}): string {
	const quoted = JSON.stringify(input.message)
	const instruction =
		quoted.length <= 20_000
			? quoted
			: `${JSON.stringify(input.message.slice(0, 2_000))} (truncated preview; the full ${input.message.length}-character instruction was admitted)`
	return `Host audit record ${JSON.stringify(input.id)}: the operator submitted ${instruction} directly to child ${JSON.stringify(input.viewId)}, task ${JSON.stringify(input.taskId)}. Admission: ${input.kind}. This is not a child-authored claim; consumption is not proved by this record. Use it to interpret child reports, not to repeat a completed assignment. This observation grants no additional permissions.`
}

/** Audit observations grant no execution authority, including after a restart. */
export async function readChildOperatorNotices(
	paths: SessionPaths,
	sessionId: SessionId,
): Promise<readonly ChildOperatorNotice[]> {
	const path = join(paths.sessionDir({ sessionId }), 'child-operator-messages.jsonl')
	let file: Awaited<ReturnType<typeof open>>
	try {
		file = await open(path, 'r')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	try {
		const size = (await file.stat()).size
		const offset = Math.max(0, size - MAX_READ_BYTES)
		const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES))
		const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
		const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
		if (offset) lines.shift()
		const accepted = new Map<string, ChildOperatorNotice>()
		const seen = new Set<string>()
		for (const line of lines) {
			if (!line.trim()) continue
			let row: Record<string, unknown>
			try {
				row = JSON.parse(line)
			} catch {
				continue
			}
			if (typeof row?.id !== 'string' || row.id.length > 100) continue
			if (row.status === 'parent-observed') {
				seen.add(row.id)
				continue
			}
			if (
				row.status === 'child-report' &&
				row.source === 'host' &&
				typeof row.text === 'string' &&
				row.text.length <= 12_000
			) {
				accepted.set(row.id, { id: row.id, text: row.text })
				continue
			}
			if (
				row.status !== 'accepted' ||
				row.source !== 'operator' ||
				typeof row.message !== 'string' ||
				row.message.length > 16_000 ||
				typeof row.taskId !== 'string' ||
				row.taskId.length > 100 ||
				typeof row.viewId !== 'string' ||
				row.viewId.length > 100
			)
				continue
			accepted.set(row.id, {
				id: row.id,
				text: formatChildOperatorAdmission({
					id: row.id,
					message: row.message,
					viewId: row.viewId,
					taskId: row.taskId,
					kind: row.kind === 'started' ? 'started' : 'queued',
				}),
			})
		}
		const notices: ChildOperatorNotice[] = []
		let characters = 0
		for (const notice of [...accepted.values()].reverse()) {
			if (seen.has(notice.id)) continue
			if (characters + notice.text.length > MAX_CONTEXT_CHARACTERS) continue
			notices.unshift(notice)
			characters += notice.text.length
		}
		return notices
	} finally {
		await file.close()
	}
}

/** A successful parent response observed this bounded context snapshot. */
export async function acknowledgeChildOperatorNotices(
	paths: SessionPaths,
	sessionId: SessionId,
	notices: readonly ChildOperatorNotice[],
): Promise<void> {
	if (!notices.length) return
	const lines = notices
		.map(({ id }) =>
			JSON.stringify({
				id,
				status: 'parent-observed',
				at: new Date().toISOString(),
			}),
		)
		.join('\n')
	await appendFile(
		join(paths.sessionDir({ sessionId }), 'child-operator-messages.jsonl'),
		`${lines}\n`,
		{ mode: 0o600 },
	)
}

/** Store the host's terminal metadata and explicitly framed child output. */
export async function recordChildOperatorReport(
	paths: SessionPaths,
	sessionId: SessionId,
	notice: ChildOperatorNotice,
): Promise<void> {
	await appendFile(
		join(paths.sessionDir({ sessionId }), 'child-operator-messages.jsonl'),
		`${JSON.stringify({ ...notice, status: 'child-report', source: 'host', at: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	)
}
