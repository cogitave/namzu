import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSessionLogLine } from '../../session/log-hash.js'
import { SessionLogChain, type SessionLogEntry } from '../../store/session-log/chain.js'
import { type RecordPointer, SESSION_RECORD_MAX_BYTES } from '../../types/session/records.js'
import { isEntityId } from '../../utils/id.js'
import { projectPalActivity } from './projection.js'
import type {
	PalActivityCursor,
	PalActivityFact,
	PalActivityReadOptions,
	PalActivityScope,
	PalActivitySource,
	PalActivitySourceOptions,
} from './types.js'

export class PalActivityAccessDeniedError extends Error {
	override readonly name = 'PalActivityAccessDeniedError'
	constructor() {
		super('Current Pal activity observation permission is required.')
	}
}
export class PalActivityIntegrityError extends Error {
	override readonly name = 'PalActivityIntegrityError'
	constructor() {
		super('Pal activity journal ownership or anchor evidence is invalid or incomplete.')
	}
}
export class PalActivityReadLimitError extends Error {
	override readonly name = 'PalActivityReadLimitError'
	constructor() {
		super('The Pal activity byte budget cannot cover another complete record and its anchors.')
	}
}

const positive = z.number().int().positive().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const pointer = z
	.object({
		seq: positive,
		offset: z.number().int().nonnegative().safe(),
		length: positive.max(SESSION_RECORD_MAX_BYTES),
		sha256: digest,
	})
	.strict()
const scopeSchema = z
	.object({
		tenantId: z.custom<PalActivityScope['tenantId']>((v) => isEntityId(v, 'tenant')),
		projectId: z.custom<PalActivityScope['projectId']>((v) => isEntityId(v, 'project')),
		sessionId: z.custom<PalActivityScope['sessionId']>((v) => isEntityId(v, 'session')),
		palId: z.string().uuid(),
		profileRevision: positive,
	})
	.strict()
const cursorSchema = z
	.object({
		v: z.literal(1),
		scopeHash: digest,
		root: pointer,
		after: pointer,
		generation: z.number().int().nonnegative().safe(),
	})
	.strict()
function samePointer(one: RecordPointer, two: RecordPointer): boolean {
	return (
		one.seq === two.seq &&
		one.offset === two.offset &&
		one.length === two.length &&
		one.sha256 === two.sha256
	)
}
function immutableCursor(value: PalActivityCursor): PalActivityCursor {
	return Object.freeze({
		...value,
		root: Object.freeze({ ...value.root }),
		after: Object.freeze({ ...value.after }),
	})
}

/** Bounded original-byte reads, with current host consent and exact Pal-root admission. */
export function createPalActivitySource(options: PalActivitySourceOptions): PalActivitySource {
	const scope = Object.freeze(scopeSchema.parse(options.scope))
	const { pals, authorize, openJournal } = options
	if (typeof authorize !== 'function' || typeof openJournal !== 'function')
		throw new TypeError('Pal activity requires explicit authorization and original-journal ports.')
	return {
		scope,
		async read(input: PalActivityReadOptions) {
			const { signal } = input
			const maxRecords = positive.max(256).parse(input.maxRecords)
			const maxReadBytes = positive.max(16 * 1024 * 1024).parse(input.maxReadBytes)
			const supplied = input.cursor ? cursorSchema.parse(input.cursor) : undefined
			signal.throwIfAborted()
			if ((await authorize(scope, signal)) !== true) throw new PalActivityAccessDeniedError()
			signal.throwIfAborted()
			const definition = pals.getRevision(scope.palId, scope.profileRevision)
			if (definition.id !== scope.palId || definition.revision !== scope.profileRevision)
				throw new PalActivityIntegrityError()
			const workspace = definition.workspace
			const scopeHash = createHash('sha256')
				.update(
					JSON.stringify([
						'pal-activity/1',
						scope.tenantId,
						scope.projectId,
						scope.palId,
						scope.profileRevision,
						scope.sessionId,
						workspace,
					]),
				)
				.digest('hex')
			if (supplied && supplied.scopeHash !== scopeHash) throw new PalActivityIntegrityError()
			const journal = await openJournal(scope, signal)
			signal.throwIfAborted()
			if (journal.log.sessionId !== scope.sessionId) throw new PalActivityIntegrityError()
			const bytes = journal.bytes
			const size = await bytes.size()
			signal.throwIfAborted()
			if (!Number.isSafeInteger(size) || size < 1) throw new PalActivityIntegrityError()
			if ((await authorize(scope, signal)) !== true) throw new PalActivityAccessDeniedError()
			signal.throwIfAborted()
			let readBytes = 0
			const read = async (offset: number, length: number): Promise<Uint8Array> => {
				signal.throwIfAborted()
				if (length > maxReadBytes - readBytes) throw new PalActivityReadLimitError()
				readBytes += length
				const raw = await bytes.read(offset, length)
				signal.throwIfAborted()
				if (raw.byteLength !== length) throw new PalActivityIntegrityError()
				return Uint8Array.from(raw)
			}
			const lineAt = async (offset: number): Promise<Uint8Array> => {
				const parts: Uint8Array[] = []
				let length = 0
				while (offset + length < size) {
					const available = maxReadBytes - readBytes
					if (available === 0) throw new PalActivityReadLimitError()
					const chunk = await read(
						offset + length,
						Math.min(1024, available, size - offset - length),
					)
					const newline = chunk.indexOf(10)
					const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1)
					parts.push(part)
					length += part.byteLength
					if (length > SESSION_RECORD_MAX_BYTES) throw new PalActivityReadLimitError()
					if (newline >= 0) return Buffer.concat(parts)
				}
				throw new PalActivityIntegrityError()
			}
			const first = await lineAt(0)
			let root: SessionLogEntry
			try {
				root = new SessionLogChain({ head: null, sessionId: scope.sessionId }).accept(first, 0)
			} catch {
				throw new PalActivityIntegrityError()
			}
			const owner = root.record
			if (
				owner.type !== 'session_started' ||
				owner.parent ||
				owner.forkedFrom ||
				owner.tenantId !== scope.tenantId ||
				owner.projectId !== scope.projectId ||
				owner.cwd !== workspace ||
				owner.origin?.protocol !== 'desktop' ||
				owner.origin.externalSessionId !==
					JSON.stringify(['namzu-pal', scope.palId, scope.profileRevision, scope.sessionId])
			)
				throw new PalActivityIntegrityError()
			if ((await read(size - 1, 1))[0] !== 10) throw new PalActivityIntegrityError()
			let after = root.pointer
			let generation = root.record.gen
			if (supplied) {
				const anchorEnd = supplied.after.offset + supplied.after.length
				if (
					!samePointer(root.pointer, supplied.root) ||
					!Number.isSafeInteger(anchorEnd) ||
					anchorEnd > size ||
					supplied.after.seq < 1 ||
					(supplied.after.seq > 1 && supplied.after.offset < root.pointer.length)
				)
					throw new PalActivityIntegrityError()
				let anchor: ReturnType<typeof parseSessionLogLine>
				try {
					anchor = parseSessionLogLine(await read(supplied.after.offset, supplied.after.length))
				} catch (error) {
					signal.throwIfAborted()
					if (error instanceof PalActivityReadLimitError) throw error
					throw new PalActivityIntegrityError()
				}
				if (
					anchor.sha256 !== supplied.after.sha256 ||
					anchor.record.sessionId !== scope.sessionId ||
					anchor.record.seq !== supplied.after.seq ||
					anchor.record.gen !== supplied.generation ||
					(supplied.after.seq === 1 && !samePointer(supplied.after, root.pointer))
				)
					throw new PalActivityIntegrityError()
				after = supplied.after
				generation = anchor.record.gen
			}
			const chain = new SessionLogChain({
				head: after,
				sessionId: scope.sessionId,
				gen: generation,
			})
			const facts: PalActivityFact[] = []
			let scannedRecords = 0
			while (chain.end < size && scannedRecords < maxRecords) {
				const raw = await lineAt(chain.end)
				let entry: SessionLogEntry
				let fact: PalActivityFact | null
				try {
					entry = chain.accept(raw, chain.end)
					fact = projectPalActivity(entry, scopeHash)
				} catch {
					throw new PalActivityIntegrityError()
				}
				scannedRecords++
				if (fact) facts.push(fact)
				after = entry.pointer
				generation = entry.record.gen
			}
			if ((await bytes.size()) < size) throw new PalActivityIntegrityError()
			signal.throwIfAborted()
			if ((await authorize(scope, signal)) !== true) throw new PalActivityAccessDeniedError()
			signal.throwIfAborted()
			return Object.freeze({
				scope,
				facts: Object.freeze(facts),
				cursor: immutableCursor({ v: 1, scopeHash, root: root.pointer, after, generation }),
				complete: chain.end === size,
				scannedRecords,
				readBytes,
			})
		},
	}
}
