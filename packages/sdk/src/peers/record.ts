/**
 * The live-session registry record (design §1.2): one JSON file per
 * participating session, written into a hardened runtime directory's
 * `sessions/` subdirectory (`resolvePeerRuntimeDir`, `dir.ts`).
 *
 * Kept separate from `registry.ts` (which reads and writes these files) so
 * `client.ts` can depend on the record SHAPE without depending on file I/O,
 * and `registry.ts` can depend on `client.ts` (to ping a peer for liveness)
 * without a cycle.
 *
 * @experimental
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
	PEER_PROTOCOL_VERSION,
	PeerRefSchema,
	PeerSessionKindSchema,
	PeerSessionStateSchema,
} from './protocol.js'

/** Bumped only if the on-disk record shape changes incompatibly. */
export const PEER_RECORD_VERSION = 1

export const PeerRecordSchema = z
	.object({
		v: z.literal(PEER_RECORD_VERSION),
		sessionId: z.string().min(1),
		/** First 6 hex characters of `sha256(sessionId)`; disambiguates a colliding display name. */
		ref: PeerRefSchema,
		pid: z.number().int().positive(),
		startedAt: z.number().int().nonnegative(),
		kind: PeerSessionKindSchema,
		/** Absent until the operator or the host sets one; the display name then falls back (design §1.2). */
		title: z.string().optional(),
		cwd: z.string().min(1),
		/** The host's own permission-mode vocabulary; the SDK does not constrain its spelling. */
		permissionMode: z.string().min(1),
		state: PeerSessionStateSchema,
		acceptsMessages: z.boolean(),
		address: z.string().min(1),
		token: z.string().min(1),
		protocol: z.literal(PEER_PROTOCOL_VERSION),
		cliVersion: z.string(),
	})
	.strict()

export type PeerRecord = z.infer<typeof PeerRecordSchema>

const PEER_REF_HEX_LENGTH = 6

/** `ref`: the first 6 hex characters of `sha256(sessionId)`, for a short, stable, collision-resistant tag. */
export function derivePeerRef(sessionId: string): string {
	return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, PEER_REF_HEX_LENGTH)
}
