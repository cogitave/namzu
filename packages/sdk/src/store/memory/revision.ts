import { createHash } from 'node:crypto'
import { NamzuError } from '../../types/errors/index.js'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryRecord } from '../../types/memory/index.js'

/** Sort object keys at every depth so equivalent records have the same token. */
function canonicalJson(value: unknown): string {
	const json = JSON.stringify(value, (_key, part: unknown) => {
		if (part === null || typeof part !== 'object' || Array.isArray(part)) return part
		if (Object.getPrototypeOf(part) !== Object.prototype) return part
		return Object.fromEntries(
			Object.entries(part as Record<string, unknown>).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		)
	})
	if (json === undefined)
		throw new Error('A memory record could not be serialized for revision checking.')
	return json
}

/** A content-derived token; it includes metadata as well as the body. */
export function memoryRevision(record: MemoryRecord): string {
	return `m1:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`
}

/** The record changed or disappeared after its revision was read. */
export class MemoryRevisionConflictError extends NamzuError {
	readonly memoryId: MemoryId

	constructor(memoryId: MemoryId) {
		super({
			code: 'storage_error',
			message: `Memory ${memoryId} changed since it was read. Read it again before changing it.`,
			details: { memoryId, reason: 'revision_conflict' },
			retryable: false,
		})
		this.name = 'MemoryRevisionConflictError'
		this.memoryId = memoryId
	}
}

export function assertMemoryRevision(
	id: MemoryId,
	record: MemoryRecord | undefined,
	expectedRevision: string,
): asserts record is MemoryRecord {
	if (!record || memoryRevision(record) !== expectedRevision) {
		throw new MemoryRevisionConflictError(id)
	}
}
