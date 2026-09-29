import { createHash } from 'node:crypto'
import { NamzuError } from '../../types/errors/index.js'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryRecord } from '../../types/memory/index.js'

/** A record can be read, but its metadata cannot be fingerprinted synchronously. */
export class MemoryRevisionUnavailableError extends Error {
	constructor() {
		super('This memory contains metadata that cannot be revision-checked.')
		this.name = 'MemoryRevisionUnavailableError'
	}
}

/**
 * Encode the same structured-clone snapshot `getRecord` returns. Type tags,
 * object references and sorted plain-object keys preserve values JSON loses:
 * BigInt, undefined, Map/Set contents, Date, typed arrays and cycles. Map and
 * Set order is kept because it is observable. Unknown host objects (notably
 * Blob, whose bytes need asynchronous reading) fail closed rather than hash as
 * `{}` and allow a stale conditional write.
 */
function canonicalRecord(record: MemoryRecord): string {
	let snapshot: MemoryRecord
	try {
		snapshot = structuredClone(record)
	} catch {
		throw new MemoryRevisionUnavailableError()
	}
	const seen = new WeakMap<object, number>()
	let nextId = 0

	function encode(value: unknown): unknown {
		if (value === null) return ['null']
		switch (typeof value) {
			case 'undefined':
				return ['undefined']
			case 'string':
				return ['string', value]
			case 'boolean':
				return ['boolean', value]
			case 'bigint':
				return ['bigint', value.toString()]
			case 'number':
				return ['number', Object.is(value, -0) ? '-0' : String(value)]
			case 'function':
			case 'symbol':
				throw new MemoryRevisionUnavailableError()
			case 'object':
				break
		}

		const object = value as object
		const previous = seen.get(object)
		if (previous !== undefined) return ['ref', previous]
		const id = nextId++
		seen.set(object, id)
		if (Array.isArray(object)) {
			return [
				'array',
				id,
				object.length,
				Object.keys(object)
					.sort()
					.map((key) => [key, encode((object as unknown as Record<string, unknown>)[key])]),
			]
		}
		if (object instanceof Map) {
			return ['map', id, [...object].map(([key, item]) => [encode(key), encode(item)])]
		}
		if (object instanceof Set) return ['set', id, [...object].map(encode)]
		if (object instanceof Date) return ['date', id, encode(object.getTime())]
		if (object instanceof RegExp)
			return ['regexp', id, object.source, object.flags, object.lastIndex]
		if (object instanceof ArrayBuffer)
			return ['array-buffer', id, Buffer.from(object).toString('hex')]
		if (ArrayBuffer.isView(object))
			return [
				'array-buffer-view',
				id,
				object.constructor.name,
				object.byteOffset,
				Buffer.from(object.buffer, object.byteOffset, object.byteLength).toString('hex'),
			]
		if (object instanceof Error) {
			return ['error', id, object.name, object.message, object.stack, encode(object.cause)]
		}
		if (object instanceof Number || object instanceof String || object instanceof Boolean)
			return ['boxed', id, object.constructor.name, encode(object.valueOf())]
		if (typeof SharedArrayBuffer !== 'undefined' && object instanceof SharedArrayBuffer)
			throw new MemoryRevisionUnavailableError()
		const prototype = Object.getPrototypeOf(object)
		if (prototype !== Object.prototype && prototype !== null)
			throw new MemoryRevisionUnavailableError()
		return [
			'object',
			id,
			Object.keys(object as Record<string, unknown>)
				.sort()
				.map((key) => [key, encode((object as Record<string, unknown>)[key])]),
		]
	}

	return JSON.stringify(encode(snapshot))
}

/** A content-derived token; it includes metadata as well as the body. */
export function memoryRevision(record: MemoryRecord): string {
	return `m2:${createHash('sha256').update(canonicalRecord(record)).digest('hex')}`
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
