import { z } from 'zod'
import type { WorkingStateSnapshot } from '../../compaction/wire.js'
import type { SerializedSpanContext } from '../../telemetry/attributes.js'
import { type EntityIdKind, isEntityId } from '../../utils/id.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type { CheckpointId, MessageId, SessionId, TurnId } from '../ids/index.js'
import type { TurnBudgetBinding } from './turn.js'

/** Version of the checkpoint document. An older or unknown version is refused, never migrated. */
export const CHECKPOINT_DOCUMENT_VERSION = 1 as const

/**
 * A checkpoint of one turn, stored at `<session-id>/checkpoints/<id>.json`.
 *
 * It holds NO messages. The context it restores is the fold of the session
 * log from seq 1 through `throughSeq`, which equals the session's context at
 * that seq because no other turn can interleave. `throughSha256` is the hash
 * of the record at `throughSeq`, and the `checkpoint_written` record carries
 * the document's own hash (`docSha256`): a restore refuses the checkpoint when
 * either does not match.
 */
export interface Checkpoint {
	readonly v: typeof CHECKPOINT_DOCUMENT_VERSION
	readonly kind: 'checkpoint'
	readonly checkpointId: CheckpointId
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly iteration: number
	readonly throughSeq: number
	readonly throughSha256: string
	readonly tokenUsage: TokenUsage
	readonly costInfo: CostInfo
	/** The ledger reference; the ledger itself stays authoritative. */
	readonly budget?: {
		readonly binding?: TurnBudgetBinding
		/** Present for non-durable accounts too; those need the live authority on resume. */
		readonly accountId: string
	}
	readonly guards: { readonly iteration: number; readonly elapsedMs: number }
	/**
	 * Review corrections already consumed at this checkpoint, independent of
	 * compactable history: host structured-output review, prose-answer review
	 * and native structured-output correction.
	 */
	readonly review: {
		readonly structuredAttempts: number
		readonly answerAttempts: number
		readonly nativeStructuredAttempts: number
	}
	/** The turn's current operator/goal/steering message, independent of compaction. */
	readonly latestUserMessageId?: MessageId
	/** Compaction's accumulated working state, when compaction is enabled. */
	readonly workingState?: WorkingStateSnapshot
	/** The trace the checkpoint was taken inside, so a resume continues it. */
	readonly trace?: SerializedSpanContext
	/** When the turn was attributed (ISO-8601). Identical on every checkpoint of the turn. */
	readonly turnCreatedAt: string
	/** When this checkpoint was written (ISO-8601). */
	readonly createdAt: string
}

const count = z.number().int().nonnegative().safe()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const iso = z.string().datetime({ offset: false })
/** Annotated with the id's own alias, so declarations name it rather than expanding its brand. */
function id<T extends string>(kind: EntityIdKind): z.ZodType<T, z.ZodTypeDef, unknown> {
	return z.custom<T>((value) => isEntityId(value, kind), {
		message: `expected a ${kind} id (UUID)`,
	})
}

export const TokenUsageSchema = z
	.object({
		promptTokens: count,
		completionTokens: count,
		totalTokens: count,
		cachedTokens: count,
		cacheWriteTokens: count,
		reasoningTokens: count.optional(),
	})
	.strict()

export const CostInfoSchema = z
	.object({
		inputCostPer1M: z.number().nonnegative().optional(),
		outputCostPer1M: z.number().nonnegative().optional(),
		totalCost: z.number().nonnegative(),
		cacheDiscount: z.number(),
		unpricedTokens: count,
	})
	.strict()

export const TurnBudgetBindingSchema = z
	.object({
		rootSessionId: id<SessionId>('session'),
		rootTurnId: id<TurnId>('turn'),
		accountId: z.string().min(1),
	})
	.strict()

export const CheckpointSchema = z
	.object({
		v: z.literal(CHECKPOINT_DOCUMENT_VERSION),
		kind: z.literal('checkpoint'),
		checkpointId: id<CheckpointId>('checkpoint'),
		sessionId: id<SessionId>('session'),
		turnId: id<TurnId>('turn'),
		iteration: count,
		throughSeq: count.positive(),
		throughSha256: sha256,
		tokenUsage: TokenUsageSchema,
		costInfo: CostInfoSchema,
		budget: z
			.object({ binding: TurnBudgetBindingSchema.optional(), accountId: z.string().min(1) })
			.strict()
			.optional(),
		guards: z.object({ iteration: count, elapsedMs: count }).strict(),
		review: z
			.object({
				structuredAttempts: count,
				answerAttempts: count,
				nativeStructuredAttempts: count,
			})
			.strict(),
		latestUserMessageId: id<MessageId>('message').optional(),
		// Each has its own validator where it is restored; the document only
		// requires an object.
		workingState: z.custom<WorkingStateSnapshot>(isPlainObject).optional(),
		trace: z.custom<SerializedSpanContext>(isPlainObject).optional(),
		turnCreatedAt: iso,
		createdAt: iso,
	})
	.strict()

function isPlainObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Raised for a checkpoint document written by another version or another shape. */
export class CheckpointDocumentError extends Error {
	override readonly name = 'CheckpointDocumentError'
}

/**
 * Parse a checkpoint document. A document from the run-era layout
 * (`kind: 'run-checkpoint'`) or any other version is refused by name.
 */
export function parseCheckpoint(value: unknown): Checkpoint {
	if (isPlainObject(value)) {
		const record = value as Record<string, unknown>
		if (record.kind !== undefined && record.kind !== 'checkpoint') {
			throw new CheckpointDocumentError(
				`Not a session checkpoint: kind ${JSON.stringify(record.kind)}. Checkpoints from earlier releases are not read.`,
			)
		}
		if (record.v !== CHECKPOINT_DOCUMENT_VERSION) {
			throw new CheckpointDocumentError(
				`Unsupported checkpoint version ${JSON.stringify(record.v)}; this release reads version ${CHECKPOINT_DOCUMENT_VERSION}.`,
			)
		}
	}
	const parsed = CheckpointSchema.safeParse(value)
	if (!parsed.success) {
		throw new CheckpointDocumentError(`Invalid checkpoint document: ${parsed.error.message}`)
	}
	return parsed.data
}
