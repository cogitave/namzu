/**
 * The `namzu-net/1` wire protocol: newline-delimited JSON inside mutual TLS,
 * one request and one response per exchange. Every schema is `.strict()`; a
 * frame with a field this build does not know is refused rather than half read.
 *
 * Nothing in a roster carries a full path, a token, a conversation id or a
 * message text.
 *
 * @experimental
 */

import { z } from 'zod'
import { AdmissionSchema, RevocationSchema } from './membership.js'

export const NET_PROTOCOL = 'namzu-net/1'
/** One authenticated line, request or response. */
export const MAX_NET_LINE_BYTES = 64 * 1024
/** A line from a machine that is not (yet) a member. */
export const MAX_PREAUTH_LINE_BYTES = 4 * 1024
export const MAX_NET_TEXT_BYTES = 32 * 1024
export const MAX_ROLE_BYTES = 500
export const MAX_NAME_LENGTH = 40
export const MAX_ROSTER_SESSIONS = 64
export const MAX_MEMBERS = 64
export const MAX_HOPS = 3

const MachineIdSchema = z
	.string()
	.length(64)
	.regex(/^[0-9a-f]+$/)
const RefSchema = z.string().regex(/^[0-9a-f]{6}$/)
const HostPortSchema = z
	.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535) })
	.strict()
export type HostPort = z.infer<typeof HostPortSchema>

const bytes = (max: number) =>
	z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= max, { message: `at most ${max} bytes` })

/** Remove control characters, collapse whitespace, cut to `max` characters. */
export function sanitizeName(value: string, max = MAX_NAME_LENGTH): string {
	const clean = Array.from(value)
		.map((ch) => (/[\p{Cc}\p{Cf}]/u.test(ch) ? ' ' : ch))
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
	return Array.from(clean).slice(0, max).join('')
}

/** A role: free text, one paragraph, at most 500 bytes. Returns undefined for an empty result. */
export function sanitizeRole(value: string): string | undefined {
	const clean = Array.from(value)
		.map((ch) => (/[\p{Cc}\p{Cf}]/u.test(ch) ? ' ' : ch))
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
	let out = ''
	for (const ch of clean) {
		if (Buffer.byteLength(out + ch, 'utf8') > MAX_ROLE_BYTES) break
		out += ch
	}
	return out.length > 0 ? out : undefined
}

export const RosterSessionSchema = z
	.object({
		ref: RefSchema,
		name: z.string().min(1).max(80),
		folder: z.string().max(120),
		state: z.enum(['idle', 'running', 'awaiting-approval']),
		mode: z.string().min(1).max(40),
		role: z.string().max(MAX_ROLE_BYTES).optional(),
		acceptsMessages: z.boolean(),
		kind: z.literal('tui'),
	})
	.strict()
export type RosterSession = z.infer<typeof RosterSessionSchema>

export const RosterMachineSchema = z
	.object({
		id: MachineIdSchema,
		name: z
			.string()
			.min(1)
			.max(MAX_NAME_LENGTH * 2),
		role: z.string().max(MAX_ROLE_BYTES).optional(),
		platform: z.string().max(20),
	})
	.strict()
export type RosterMachine = z.infer<typeof RosterMachineSchema>

export const RosterSchema = z
	.object({
		machine: RosterMachineSchema,
		sessions: z.array(RosterSessionSchema).max(MAX_ROSTER_SESSIONS),
	})
	.strict()
export type Roster = z.infer<typeof RosterSchema>

const head = <T extends string>(op: T) => ({ protocol: z.literal(NET_PROTOCOL), op: z.literal(op) })

export const PingNetRequestSchema = z.object({ ...head('ping_net') }).strict()

export const JoinRequestSchema = z
	.object({
		...head('join_request'),
		machineName: z
			.string()
			.min(1)
			.max(MAX_NAME_LENGTH * 2),
		publicKey: z.string().min(1).max(256),
		nonce: z.string().min(16).max(64),
	})
	.strict()
export type JoinRequest = z.infer<typeof JoinRequestSchema>

export const HelloRequestSchema = z
	.object({
		...head('hello'),
		machineName: z
			.string()
			.min(1)
			.max(MAX_NAME_LENGTH * 2),
		addresses: z.array(HostPortSchema).max(8),
		protocolMax: z.number().int().min(1).max(100),
	})
	.strict()

export const MembersSyncRequestSchema = z
	.object({
		...head('members_sync'),
		admissions: z.array(AdmissionSchema).max(MAX_MEMBERS * 2),
		revocations: z.array(RevocationSchema).max(MAX_MEMBERS * 2),
	})
	.strict()

export const JoinPendingRequestSchema = z
	.object({
		...head('join_pending'),
		requestId: z.string().min(1).max(64),
		name: z
			.string()
			.min(1)
			.max(MAX_NAME_LENGTH * 2),
		code: z.string().regex(/^\d{6}$/),
		sourceAddr: z.string().max(80),
		createdAt: z.number().int().nonnegative(),
		viaMachineId: MachineIdSchema,
		/** The joiner's key, SPKI DER base64, so any member can sign its admission. */
		publicKey: z.string().min(1).max(256),
	})
	.strict()
export type JoinPendingRequest = z.infer<typeof JoinPendingRequestSchema>

export const JoinDecisionRequestSchema = z
	.object({
		...head('join_decision'),
		requestId: z.string().min(1).max(64),
		decision: z.enum(['allow', 'deny']),
		admission: AdmissionSchema.optional(),
	})
	.strict()

export const RosterRequestSchema = z.object({ ...head('roster') }).strict()

export const RoleTargetSchema = z.union([
	z.object({ machine: z.literal(true) }).strict(),
	z.object({ sessionRef: RefSchema }).strict(),
])
export type RoleTarget = z.infer<typeof RoleTargetSchema>

export const RoleSetRequestSchema = z
	.object({
		...head('role_set'),
		target: RoleTargetSchema,
		role: bytes(MAX_ROLE_BYTES).nullable(),
		by: z
			.object({
				machineName: z
					.string()
					.min(1)
					.max(MAX_NAME_LENGTH * 2),
			})
			.strict(),
		at: z.number().int().nonnegative(),
	})
	.strict()
export type RoleSetRequest = z.infer<typeof RoleSetRequestSchema>

export const NetDeliverRequestSchema = z
	.object({
		...head('net_deliver'),
		id: z.string().min(1).max(100),
		to: z.object({ sessionRef: RefSchema }).strict(),
		from: z
			.object({
				sessionRef: RefSchema,
				sessionName: z.string().min(1).max(80),
				mode: z.string().min(1).max(40),
				kind: z.literal('tui'),
			})
			.strict(),
		text: z
			.string()
			.min(1)
			.refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_NET_TEXT_BYTES, {
				message: `at most ${MAX_NET_TEXT_BYTES} bytes`,
			}),
		inReplyTo: z.string().min(1).max(100).optional(),
		hops: z.number().int().min(0).max(100),
	})
	.strict()
export type NetDeliverRequest = z.infer<typeof NetDeliverRequestSchema>

export const NetOutcomeSchema = z.enum(['delivered', 'queued', 'held', 'refused', 'expired'])
export type NetOutcome = z.infer<typeof NetOutcomeSchema>

export const NetNoticeRequestSchema = z
	.object({
		...head('net_notice'),
		about: z.object({ id: z.string().min(1).max(100) }).strict(),
		outcome: NetOutcomeSchema,
		detail: z.string().max(200).optional(),
		from: z.object({ sessionRef: RefSchema }).strict(),
	})
	.strict()
export type NetNoticeRequest = z.infer<typeof NetNoticeRequestSchema>

export const NetRequestSchema = z.discriminatedUnion('op', [
	PingNetRequestSchema,
	JoinRequestSchema,
	HelloRequestSchema,
	MembersSyncRequestSchema,
	JoinPendingRequestSchema,
	JoinDecisionRequestSchema,
	RosterRequestSchema,
	RoleSetRequestSchema,
	NetDeliverRequestSchema,
	NetNoticeRequestSchema,
])
export type NetRequest = z.infer<typeof NetRequestSchema>
export type NetOp = NetRequest['op']

/** The only operations a machine that is not a member may use. */
export const PREAUTH_OPS: ReadonlySet<NetOp> = new Set<NetOp>(['ping_net', 'join_request'])

export const DeliverReplySchema = z
	.object({ status: z.enum(['queued', 'held', 'refused']), reason: z.string().max(200).optional() })
	.strict()
export type DeliverReply = z.infer<typeof DeliverReplySchema>
