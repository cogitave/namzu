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
	readonly contentSource?:
		| 'tool-result'
		| 'history'
		| 'media-removed'
		| 'media-removed-current'
		| 'media-limit'
	readonly providerId?: string
}

/** One sentence: what the provider cannot do, what Namzu did about it, and what the person can do. */
export function describeCapabilityNotice(input: CapabilityNoticeInput): string {
	const name = productName(input.providerId) ?? 'This provider'
	if (input.contentSource === 'media-limit') {
		// Not a fault in any file: the provider takes only so many at once.
		return 'This conversation holds more pictures or files than this model accepts at once, so Namzu left the oldest out of what it sends. They stay in the conversation.'
	}
	if (input.contentSource === 'media-removed-current') {
		// The person attached it just now, so say so rather than let it vanish quietly.
		return input.capability === 'documents'
			? 'The document you just attached couldn’t be processed, so Namzu left it out of this reply. It stays in the conversation; attach a corrected copy to try again.'
			: 'The picture you just attached couldn’t be processed, so Namzu left it out of this reply. It stays in the conversation; attach a corrected copy to try again.'
	}
	if (input.contentSource === 'media-removed') {
		// The provider refused a file and Namzu retried without it; the conversation keeps the file.
		return input.capability === 'documents'
			? 'A document in this conversation couldn’t be processed, so Namzu left it out of what it sends. It stays in the conversation; attach a corrected copy to try again.'
			: 'A picture in this conversation couldn’t be processed, so Namzu left it out of what it sends. It stays in the conversation; attach a corrected copy to try again.'
	}
	if (input.contentSource === 'history') {
		// The conversation keeps its pictures; only this model's requests lose them.
		return 'This model can’t read images, so Namzu is leaving pictures out of what it sends. They come back if you pick a model that reads images with /model.'
	}
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
	/** Of the interrupted calls, those that never started. */
	readonly neverRanCalls?: number
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
		// Every unfinished call never started: nothing they asked for happened.
		if (input.neverRanCalls === input.interruptedCalls)
			return 'Some tool calls in this conversation never started, so Namzu marked them as not run. Nothing they asked for happened.'
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

/**
 * A provider switch for a person reading a saved conversation: product names and a plain reason, no codes.
 *
 * The model is named when it is known, on the side that took over, so a run
 * that fell over to another model of the same provider still says which one
 * answered.
 */
export function describeProviderFallbackNotice(input: {
	readonly fromProviderId: string
	readonly toProviderId: string
	readonly reason: string
	readonly fromModel?: string | undefined
	readonly toModel?: string | undefined
}): string {
	const named = (id: string, model: string | undefined, unknown: string): string => {
		const product = productName(id) ?? unknown
		return model ? `${product} (${model})` : product
	}
	const sameProvider = input.fromProviderId === input.toProviderId
	const from = named(
		input.fromProviderId,
		sameProvider ? input.fromModel : undefined,
		'The first provider',
	)
	const to = named(input.toProviderId, input.toModel, 'another provider')
	const why = FALLBACK_WHY[input.reason] ?? 'could not answer'
	return `${from} ${why}, so Namzu used ${to} for the rest of that reply.`
}

/** The plain sentence, with the kernel's own wording after it only when detail was asked for. */
export function withDebugDetail(plain: string, raw: string, debug: boolean): string {
	return debug && raw.trim() !== '' ? `${plain}\n${raw}` : plain
}
