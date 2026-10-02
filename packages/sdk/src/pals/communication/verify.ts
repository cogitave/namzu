import { isDeepStrictEqual } from 'node:util'
import type { SessionLogEntry } from '../../store/session-log/chain.js'
import type { SessionLogRead } from '../../store/session-log/core.js'
import type { InboundDeliveryReceipt } from '../../types/message/inbound-delivery.js'
import type { UserMessage } from '../../types/message/index.js'
import {
	checkedIngressIntent,
	ingressBindingSchema,
	ingressInboxSchema,
	ingressReceiptSchema,
	ingressRouteId,
} from './ingress-schema.js'
import {
	type PalIngressInboxMessage,
	type PalIngressVerificationContext,
	ingressMessageRef,
	ingressRuntimeContextKind,
} from './ingress-types.js'
import { freezeCommunicationValue } from './schema.js'
import type { PalInboxMessage, PalVerificationContext } from './types.js'

function capturedContext(input: PalIngressVerificationContext): PalIngressVerificationContext {
	return {
		binding: freezeCommunicationValue(ingressBindingSchema.parse(input.binding)),
		definition: { ...input.definition },
		access: { ...input.access },
	}
}

/** Read original records, never compacted model history or model-supplied evidence. */
export async function verifyIngressConversation(
	inputContext: PalIngressVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<SessionLogRead> {
	const context = capturedContext(inputContext)
	const { binding, access, definition } = context
	if (
		access.log.sessionId !== binding.sessionId ||
		definition.id !== binding.key.recipient.palId ||
		definition.revision !== binding.profileRevision
	)
		throw new Error('Foreign Pal conversation access.')
	const read = await access.log.readAll({
		mode: 'strict',
		...(through ? { expectHead: through.pointer } : {}),
	})
	if (!read.intact || read.tornBytes !== 0)
		throw new Error('Pal conversation has incomplete delivery evidence.')
	if (through) {
		const covered = read.entries.find((entry) => entry.record.seq === through.pointer.seq)
		if (
			!covered ||
			covered.record.gen !== through.gen ||
			through.bytes !== through.pointer.offset + through.pointer.length
		)
			throw new Error('Delivery receipt does not name the actual verified log head.')
	}
	const first = read.entries[0]?.record
	if (
		first?.type !== 'session_started' ||
		first.parent ||
		first.forkedFrom ||
		first.sessionId !== binding.sessionId ||
		first.projectId !== access.projectId ||
		first.tenantId !== binding.key.recipient.tenantId ||
		first.cwd !== definition.workspace ||
		first.origin?.protocol !== 'desktop' ||
		first.origin.externalSessionId !==
			JSON.stringify(['namzu-pal', definition.id, definition.revision, binding.sessionId])
	)
		throw new Error('Conversation is not claimed by the exact Pal and profile revision.')
	return read
}

function checkedDelivery(
	input: PalIngressInboxMessage,
	context: PalIngressVerificationContext,
): PalIngressInboxMessage {
	const message = ingressInboxSchema.parse(input) as PalIngressInboxMessage
	const raw = { ...message } as Record<string, unknown>
	for (const key of ['ordinal', 'routeId', 'phase', 'claim', 'receipt']) delete raw[key]
	checkedIngressIntent(raw)
	if (
		message.routeId !== ingressRouteId(message.routeKey) ||
		context.binding.id !== ingressRouteId(context.binding.key) ||
		context.binding.id !== message.routeId ||
		!isDeepStrictEqual(context.binding.key, message.routeKey) ||
		!message.claim ||
		message.claim.sessionId !== context.binding.sessionId
	)
		throw new Error('Foreign delivery route or claim.')
	return message
}

async function matches(
	entry: SessionLogEntry,
	message: PalIngressInboxMessage,
	context: PalIngressVerificationContext,
): Promise<boolean> {
	const record = entry.record
	if (
		!message.claim ||
		record.type !== 'message' ||
		record.role !== 'user' ||
		record.turnId !== message.claim.turnId ||
		record.gen !== message.claim.generation
	)
		return false
	const content = (
		record.spill ? JSON.parse(await context.access.log.readSpill(record.spill)) : record.content
	) as Partial<UserMessage> & { source?: unknown }
	if (
		!content ||
		content.role !== 'user' ||
		content.content !== message.claim.content ||
		!content.source ||
		typeof content.source !== 'object'
	)
		return false
	const source = content.source as {
		type?: unknown
		kind?: unknown
		deliveryRef?: unknown
	}
	return (
		source.type === 'runtime-context' &&
		source.kind === ingressRuntimeContextKind(message) &&
		isDeepStrictEqual(source.deliveryRef, ingressMessageRef(message))
	)
}

export async function findRecordedIngressMessage(
	inputMessage: PalIngressInboxMessage,
	inputContext: PalIngressVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<{ read: SessionLogRead; entry: SessionLogEntry | null }> {
	const context = capturedContext(inputContext)
	const message = checkedDelivery(inputMessage, context)
	const read = await verifyIngressConversation(context, through)
	let found: SessionLogEntry | null = null
	for (const entry of read.entries) {
		if (!(await matches(entry, message, context))) continue
		if (found) throw new Error('Pal delivery appears more than once in the conversation log.')
		found = entry
	}
	return { read, entry: found }
}

export async function verifyIngressRecorded(
	inputMessage: PalIngressInboxMessage,
	inputReceipt: InboundDeliveryReceipt,
	inputContext: PalIngressVerificationContext,
): Promise<void> {
	const context = capturedContext(inputContext)
	const message = checkedDelivery(inputMessage, context)
	const receipt = ingressReceiptSchema.parse(inputReceipt)
	if (
		!message.claim ||
		context.binding.id !== message.routeId ||
		!isDeepStrictEqual(context.binding.key, message.routeKey) ||
		!isDeepStrictEqual(receipt.ref, ingressMessageRef(message)) ||
		receipt.claimId !== message.claim.id ||
		receipt.sessionId !== message.claim.sessionId ||
		receipt.turnId !== message.claim.turnId ||
		receipt.through.gen < message.claim.generation
	)
		throw new Error('Foreign delivery route or receipt.')
	const { entry } = await findRecordedIngressMessage(message, context, receipt.through)
	if (
		!entry ||
		entry.record.type !== 'message' ||
		entry.record.messageId !== receipt.messageId ||
		entry.record.seq > receipt.through.pointer.seq
	)
		throw new Error('No matching recorded message covers this Pal delivery receipt.')
}

export async function verifyIngressUnrecorded(
	inputMessage: PalIngressInboxMessage,
	inputContext: PalIngressVerificationContext,
): Promise<void> {
	const context = capturedContext(inputContext)
	const message = checkedDelivery(inputMessage, context)
	if (!message.claim || context.binding.id !== message.routeId)
		throw new Error('Foreign delivery route.')
	const { entry } = await findRecordedIngressMessage(message, context)
	if (entry) throw new Error('Recorded delivery cannot be released for retry.')
	const lease = await context.access.log.lease()
	const active = await context.access.log.activeTurn()
	if (!lease || lease.fence <= message.claim.generation || active !== null)
		throw new Error('Unrecorded delivery has no proof of a fenced and stopped writer.')
}

/** Legacy Pal-only verification retains its existing signatures. */
export function verifyConversation(
	context: PalVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<SessionLogRead> {
	return verifyIngressConversation(context, through)
}
export function findRecordedMessage(
	message: PalInboxMessage,
	context: PalVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<{ read: SessionLogRead; entry: SessionLogEntry | null }> {
	return findRecordedIngressMessage(message, context, through)
}
export function verifyRecorded(
	message: PalInboxMessage,
	receipt: InboundDeliveryReceipt,
	context: PalVerificationContext,
): Promise<void> {
	return verifyIngressRecorded(message, receipt, context)
}
export function verifyUnrecorded(
	message: PalInboxMessage,
	context: PalVerificationContext,
): Promise<void> {
	return verifyIngressUnrecorded(message, context)
}
