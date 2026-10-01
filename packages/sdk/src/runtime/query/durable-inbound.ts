import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import {
	type DurableInboundSource,
	type InboundDeliveryReceipt,
	isInboundDeliveryRef,
} from '../../types/message/inbound-delivery.js'
import { isRuntimeContextMessageSource } from '../../types/message/index.js'

/** Only an active writer can claim or acknowledge input for this turn. */
async function assertWriter(recorder: TurnRecorder, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted()
	const own = recorder.lease
	const current = await recorder.log.lease()
	const active = await recorder.log.activeTurn()
	signal.throwIfAborted()
	if (
		!own ||
		!current ||
		own.fence !== current.fence ||
		own.holder !== current.holder ||
		active?.turnId !== recorder.turnId ||
		active.state !== 'running' ||
		active.ownerGen !== own.fence
	) {
		throw new Error('Durable input requires the current active session writer.')
	}
}

/** Append normally, flush the recorder, then await the host's exact acknowledgement. */
export async function deliverDurableInbound(
	recorder: TurnRecorder,
	source: DurableInboundSource | undefined,
	signal: AbortSignal,
): Promise<number> {
	if (!source) return 0
	await assertWriter(recorder, signal)
	const supplied = await source.claim({
		sessionId: recorder.sessionId,
		turnId: recorder.turnId,
		signal,
	})
	signal.throwIfAborted()
	// Snapshot before the next await: the host retains its own objects.
	// Never let mutation during a writer check or queued append
	// change the payload or reference we subsequently acknowledge.
	const claims = structuredClone(supplied).map((claim) => ({
		...claim,
		message: { ...claim.message, id: undefined },
	}))
	const seen = new Set<string>()
	for (const claim of claims) {
		if (
			typeof claim.claimId !== 'string' ||
			claim.claimId.length === 0 ||
			claim.claimId.length > 512 ||
			seen.has(claim.claimId) ||
			!isInboundDeliveryRef(claim.ref) ||
			claim.message?.role !== 'user' ||
			typeof claim.message.content !== 'string'
		) {
			throw new Error('Invalid durable inbound claim.')
		}
		seen.add(claim.claimId)
		const provenance: unknown = claim.message.source
		if (!isRuntimeContextMessageSource(provenance) || provenance.kind === 'steering')
			throw new Error('Durable input requires validated runtime context provenance.')
		const ref = provenance.deliveryRef
		if (
			!ref ||
			ref.namespace !== claim.ref.namespace ||
			ref.id !== claim.ref.id ||
			ref.digest !== claim.ref.digest
		) {
			throw new Error('Durable input provenance does not match its claim.')
		}
		// Restored IDs are never evidence for a fresh delivery. The recorder
		// assigns the actual message record ID on this new, stampable object.
	}
	await assertWriter(recorder, signal)
	if (claims.length === 0) return 0
	for (const claim of claims) recorder.pushMessage(claim.message)
	const through = await recorder.head()
	if (!through) throw new Error('Durable input has no recorded session-log head.')
	await assertWriter(recorder, signal)
	const receipts: InboundDeliveryReceipt[] = claims.map((claim) => {
		const messageId = recorder.recordedIdOf(claim.message)
		if (!messageId || claim.message.id !== messageId)
			throw new Error('Durable input was not recorded.')
		return {
			claimId: claim.claimId,
			ref: Object.freeze({ ...claim.ref }),
			sessionId: recorder.sessionId,
			turnId: recorder.turnId,
			messageId,
			through: structuredClone(through),
		}
	})
	await source.recorded(receipts)
	await assertWriter(recorder, signal)
	return claims.length
}
