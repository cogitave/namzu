import { productName } from './person-terms.js'

/**
 * The transcript sentences for the two kernel notices that are not failures: a
 * provider that cannot take something the conversation holds, and a history
 * that was repaired before a reply.
 *
 * They are built from the event's structured fields, never from the kernel's
 * own message, because that message names the provider by its id and counts
 * tools. The kernel's text is for `--debug` and the log; see `withDebugDetail`.
 */

export type CapabilityKind = 'tools' | 'vision' | 'documents'

export interface CapabilityNoticeInput {
	readonly capability: CapabilityKind
	/** `'tool-result'` when the mismatch came from something a tool returned. */
	readonly contentSource?: 'tool-result'
	readonly providerId?: string
}

/** One sentence: what the provider cannot do, what Namzu did about it, and what the person can do. */
export function describeCapabilityNotice(input: CapabilityNoticeInput): string {
	const name = productName(input.providerId) ?? 'This provider'
	if (input.contentSource === 'tool-result') {
		return input.capability === 'documents'
			? `${name} can’t read documents, so Namzu gave it a text note in place of a document a tool returned. Switch to a provider that reads documents to include it.`
			: `${name} can’t see images, so Namzu gave it a text note in place of a picture a tool returned. Switch to a provider that reads images to include it.`
	}
	switch (input.capability) {
		case 'tools':
			return `${name} can’t use tools, so Namzu will only chat while you use it. Switch to another provider to let Namzu work with files and commands.`
		case 'vision':
			return `${name} can’t see images, so it won’t see the picture you attached. Switch to a provider that reads images to include it.`
		case 'documents':
			return `${name} can’t read documents, so it won’t see the file you attached. Switch to a provider that reads documents to include it.`
	}
}

export type HistoryRepairSource =
	| 'fresh-history'
	| 'abandoned-checkpoint'
	| 'provider-rejected-image'

export interface HistoryRepairNoticeInput {
	readonly source: HistoryRepairSource
	readonly duplicateResults?: number
	readonly orphanedResults?: number
	readonly interruptedCalls?: number
	readonly rejectedImages?: number
	/** The provider the conversation is using, for the rejected-image case (the event does not name it). */
	readonly providerId?: string
}

export function describeHistoryRepairNotice(input: HistoryRepairNoticeInput): string {
	if (input.source === 'provider-rejected-image') {
		const count = input.rejectedImages ?? 0
		const what =
			count > 1
				? `${count.toLocaleString('en-US')} pictures you attached`
				: 'a picture you attached'
		const name = productName(input.providerId)
		return name
			? `${name} didn’t accept ${what}. Namzu kept the file but will leave it out of later messages. Attach a corrected copy to try again.`
			: `${what.charAt(0).toUpperCase()}${what.slice(1)} wasn’t accepted. Namzu kept the file but will leave it out of later messages. Attach a corrected copy to try again.`
	}
	if ((input.interruptedCalls ?? 0) > 0) {
		return input.source === 'abandoned-checkpoint'
			? 'Your last reply was cut off before its steps finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again.'
			: 'Some steps in this conversation never finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again.'
	}
	return 'Namzu cleaned up some leftover steps from earlier in this conversation. Nothing you need to do.'
}

const FALLBACK_WHY: Readonly<Record<string, string>> = {
	rate_limit: 'was too busy',
	overloaded: 'was too busy',
	server_error: 'kept failing',
	timeout: 'did not answer in time',
	network: 'could not be reached',
	auth: 'did not accept the sign-in',
	not_found: 'does not have that model',
}

/** A provider switch for a person reading a saved conversation: product names and a plain reason, no codes. */
export function describeProviderFallbackNotice(input: {
	readonly fromProviderId: string
	readonly toProviderId: string
	readonly reason: string
}): string {
	const from = productName(input.fromProviderId) ?? 'The first provider'
	const to = productName(input.toProviderId) ?? 'another provider'
	const why = FALLBACK_WHY[input.reason] ?? 'could not answer'
	return `${from} ${why}, so Namzu used ${to} for the rest of that reply.`
}

/** The plain sentence, with the kernel's own wording after it only when detail was asked for. */
export function withDebugDetail(plain: string, raw: string, debug: boolean): string {
	return debug && raw.trim() !== '' ? `${plain}\n${raw}` : plain
}
