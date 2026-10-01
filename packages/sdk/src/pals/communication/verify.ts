import { isDeepStrictEqual } from 'node:util'
import type { SessionLogEntry } from '../../store/session-log/chain.js'
import type { SessionLogRead } from '../../store/session-log/core.js'
import type { InboundDeliveryReceipt } from '../../types/message/inbound-delivery.js'
import type { UserMessage } from '../../types/message/index.js'
import { type PalInboxMessage, type PalVerificationContext, palMessageRef } from './types.js'

/** Read original records, never compacted model history or model-supplied evidence. */
export async function verifyConversation(
	context: PalVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<SessionLogRead> {
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

async function matches(
	entry: SessionLogEntry,
	message: PalInboxMessage,
	context: PalVerificationContext,
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
	const source = content.source as { type?: unknown; kind?: unknown; deliveryRef?: unknown }
	return (
		source.type === 'runtime-context' &&
		source.kind === 'peer-message' &&
		isDeepStrictEqual(source.deliveryRef, palMessageRef(message))
	)
}

export async function findRecordedMessage(
	message: PalInboxMessage,
	context: PalVerificationContext,
	through?: InboundDeliveryReceipt['through'],
): Promise<{ read: SessionLogRead; entry: SessionLogEntry | null }> {
	const read = await verifyConversation(context, through)
	let found: SessionLogEntry | null = null
	for (const entry of read.entries) {
		if (!(await matches(entry, message, context))) continue
		if (found) throw new Error('Pal delivery appears more than once in the conversation log.')
		found = entry
	}
	return { read, entry: found }
}

export async function verifyRecorded(
	message: PalInboxMessage,
	receipt: InboundDeliveryReceipt,
	context: PalVerificationContext,
): Promise<void> {
	if (context.binding.id !== message.routeId) throw new Error('Foreign delivery route.')
	const { entry } = await findRecordedMessage(message, context, receipt.through)
	if (
		!entry ||
		entry.record.type !== 'message' ||
		entry.record.messageId !== receipt.messageId ||
		entry.record.seq > receipt.through.pointer.seq
	)
		throw new Error('No matching recorded message covers this Pal delivery receipt.')
}

export async function verifyUnrecorded(
	message: PalInboxMessage,
	context: PalVerificationContext,
): Promise<void> {
	if (!message.claim || context.binding.id !== message.routeId)
		throw new Error('Foreign delivery route.')
	const { entry } = await findRecordedMessage(message, context)
	if (entry) throw new Error('Recorded delivery cannot be released for retry.')
	const lease = await context.access.log.lease()
	const active = await context.access.log.activeTurn()
	if (!lease || lease.fence <= message.claim.generation || active !== null)
		throw new Error('Unrecorded delivery has no proof of a fenced and stopped writer.')
}
