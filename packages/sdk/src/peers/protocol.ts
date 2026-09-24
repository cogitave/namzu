/**
 * The `namzu-peer/1` wire protocol: newline-delimited JSON, one request and
 * one response per connection, a closed set of four operations (design
 * §1.1, §1.3).
 *
 * Two deliberate departures from the design note, both narrow and both
 * documented where they matter most:
 *
 * 1. **`ping` carries no token.** Every other op requires and verifies the
 *    recipient's token; `ping` is idempotent, has no side effect, and its
 *    answer (`{ok, state}`) discloses nothing the OS-user directory
 *    permission does not already gate (design §1.1: "the directory
 *    permission is the real gate"). `PeerClient.ping(address)` — the shape
 *    the spec's own client API names — takes no record and so has no token
 *    to send.
 * 2. **`notice`'s `delivery` kind carries an optional `outcome`.** The design
 *    lists `notice`'s payload as `{kind, about, detail?}` with prose detail
 *    ("approved" / "denied" / "expired") for a delivery outcome, but gives
 *    `formatSystemEvent` a closed status set that a delivery notice must
 *    report from (`queued` | `held` | `refused`). `outcome` supplies that
 *    machine-readable status without parsing `detail`'s prose.
 *
 * @experimental
 */

import { z } from 'zod'

export const PEER_PROTOCOL_VERSION = 'namzu-peer/1'

/** One request line, or one response line, must not exceed this many bytes. */
export const MAX_PEER_REQUEST_BYTES = 64 * 1024
/** `deliver.text` must not exceed this many UTF-8 bytes. */
export const MAX_PEER_MESSAGE_TEXT_BYTES = 32 * 1024
/** A connection that has not completed one request/response by this deadline is dropped. */
export const DEFAULT_PEER_READ_DEADLINE_MS = 2_000
/** Concurrent connections a `createPeerEndpoint` server accepts before refusing new ones. */
export const MAX_PEER_CONNECTIONS = 16

export const PeerSessionKindSchema = z.enum(['tui', 'exec', 'resident', 'scheduled'])
export type PeerSessionKind = z.infer<typeof PeerSessionKindSchema>

export const PeerSessionStateSchema = z.enum(['busy', 'idle', 'awaiting-permission'])
export type PeerSessionState = z.infer<typeof PeerSessionStateSchema>

const REF_PATTERN = /^[0-9a-f]{6}$/

/** First 6 hex characters of `sha256(sessionId)` — see `registry.ts` `derivePeerRef`. */
export const PeerRefSchema = z.string().regex(REF_PATTERN, 'must be 6 lowercase hex characters')

function byteLimitedString(maxBytes: number, message: string) {
	return z
		.string()
		.min(1)
		.refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, { message })
}

/** The sender's asserted identity, checked by the recipient against its own registry (§1.3). */
export const PeerFromSchema = z
	.object({
		sessionId: z.string().min(1),
		ref: PeerRefSchema,
		name: z.string(),
		address: z.string().min(1),
		mode: z.string().min(1),
		kind: PeerSessionKindSchema,
	})
	.strict()
export type PeerFrom = z.infer<typeof PeerFromSchema>

// ─── ping ──────────────────────────────────────────────────────────────────

export const PingRequestSchema = z
	.object({
		protocol: z.literal(PEER_PROTOCOL_VERSION),
		op: z.literal('ping'),
	})
	.strict()
export type PingRequest = z.infer<typeof PingRequestSchema>

export const PingResponseSchema = z
	.object({
		ok: z.boolean(),
		state: PeerSessionStateSchema,
	})
	.strict()
export type PingResponse = z.infer<typeof PingResponseSchema>

// ─── deliver ─────────────────────────────────────────────────────────────

export const DeliverRequestSchema = z
	.object({
		protocol: z.literal(PEER_PROTOCOL_VERSION),
		op: z.literal('deliver'),
		token: z.string().min(1),
		id: z.string().min(1),
		from: PeerFromSchema,
		text: byteLimitedString(
			MAX_PEER_MESSAGE_TEXT_BYTES,
			`must be at most ${MAX_PEER_MESSAGE_TEXT_BYTES} UTF-8 bytes`,
		),
		inReplyTo: z.string().min(1).optional(),
		subscribeIdle: z.boolean().optional(),
	})
	.strict()
export type DeliverRequest = z.infer<typeof DeliverRequestSchema>

export const DeliverStatusSchema = z.enum(['queued', 'held', 'refused'])
export type DeliverStatus = z.infer<typeof DeliverStatusSchema>

export const DeliverResponseSchema = z
	.object({
		status: DeliverStatusSchema,
		reason: z.string().optional(),
	})
	.strict()
export type DeliverResponse = z.infer<typeof DeliverResponseSchema>

// ─── subscribe_idle ────────────────────────────────────────────────────────

export const SubscribeIdleRequestSchema = z
	.object({
		protocol: z.literal(PEER_PROTOCOL_VERSION),
		op: z.literal('subscribe_idle'),
		token: z.string().min(1),
		id: z.string().min(1),
		from: PeerFromSchema,
	})
	.strict()
export type SubscribeIdleRequest = z.infer<typeof SubscribeIdleRequestSchema>

export const SubscribeIdleResponseSchema = z
	.object({
		status: z.enum(['subscribed', 'refused']),
	})
	.strict()
export type SubscribeIdleResponse = z.infer<typeof SubscribeIdleResponseSchema>

// ─── notice ────────────────────────────────────────────────────────────────

export const PeerNoticeAboutSchema = z
	.object({
		sessionId: z.string().min(1),
		name: z.string(),
		ref: PeerRefSchema,
	})
	.strict()
export type PeerNoticeAbout = z.infer<typeof PeerNoticeAboutSchema>

export const NoticeRequestSchema = z
	.object({
		protocol: z.literal(PEER_PROTOCOL_VERSION),
		op: z.literal('notice'),
		token: z.string().min(1),
		/**
		 * The sender's asserted identity, checked the same way `deliver` and
		 * `subscribe_idle` check theirs (§1.3): the recipient's endpoint runs it
		 * through `verifySender` before calling `onNotice`. A notice with no
		 * `from` — the shape this protocol shipped with first — is not a
		 * well-formed request at all, the same as a `deliver` with no `from`.
		 */
		from: PeerFromSchema,
		kind: z.enum(['idle', 'exited', 'delivery']),
		about: PeerNoticeAboutSchema,
		/** Only meaningful, and only ever set, when `kind === 'delivery'`. */
		outcome: DeliverStatusSchema.optional(),
		detail: z.string().optional(),
	})
	.strict()
export type NoticeRequest = z.infer<typeof NoticeRequestSchema>

export const NoticeResponseSchema = z
	.object({
		ok: z.boolean(),
	})
	.strict()
export type NoticeResponse = z.infer<typeof NoticeResponseSchema>

/** The notice payload alone, with no envelope — what a host builds and what `formatPeerNotice` renders. */
export const PeerNoticePayloadSchema = NoticeRequestSchema.omit({
	protocol: true,
	op: true,
	token: true,
})
export type PeerNoticePayload = z.infer<typeof PeerNoticePayloadSchema>

// ─── the closed op set ───────────────────────────────────────────────────

export const PeerRequestSchema = z.discriminatedUnion('op', [
	PingRequestSchema,
	DeliverRequestSchema,
	SubscribeIdleRequestSchema,
	NoticeRequestSchema,
])
export type PeerRequest = z.infer<typeof PeerRequestSchema>

export type PeerResponse = PingResponse | DeliverResponse | SubscribeIdleResponse | NoticeResponse
