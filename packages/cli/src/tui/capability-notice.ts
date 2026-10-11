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
			? `${name} can’t read documents, so Namzu gave it a text note in place of a document a tool returned. Pick a model that reads documents to include it.`
			: `${name} can’t see images, so Namzu gave it a text note in place of a picture a tool returned. Pick a model that reads images to include it.`
	}
	switch (input.capability) {
		case 'tools':
			return `${name} can’t use tools, so Namzu will only chat in this conversation. Pick another model to let it work with files and commands.`
		case 'vision':
			return `${name} can’t see images, so it won’t see the picture you attached. Pick a model that reads images to include it.`
		case 'documents':
			return `${name} can’t read documents, so it won’t see the file you attached. Pick a model that reads documents to include it.`
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

function plural(count: number, one: string, many: string): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

export function describeHistoryRepairNotice(input: HistoryRepairNoticeInput): string {
	if (input.source === 'provider-rejected-image') {
		const name = productName(input.providerId) ?? 'The provider'
		const count = input.rejectedImages ?? 0
		const what =
			count === 1
				? 'a picture you attached'
				: count > 1
					? `${count.toLocaleString('en-US')} pictures you attached`
					: 'a picture you attached'
		return `${name} didn’t accept ${what}. Namzu kept the file but will leave it out of later messages. Attach a corrected copy to try again.`
	}
	const changes = [
		input.duplicateResults
			? plural(input.duplicateResults, 'repeated result removed', 'repeated results removed')
			: null,
		input.orphanedResults
			? plural(
					input.orphanedResults,
					'result without a matching step removed',
					'results without a matching step removed',
				)
			: null,
		input.interruptedCalls
			? plural(
					input.interruptedCalls,
					'interrupted step marked as unfinished',
					'interrupted steps marked as unfinished',
				)
			: null,
	].filter((part): part is string => part !== null)
	const detail = changes.length > 0 ? ` (${changes.join('; ')})` : ''
	const lead =
		input.source === 'abandoned-checkpoint'
			? 'An earlier reply was cut off, so Namzu tidied its unfinished steps before going on'
			: 'Some earlier steps in this conversation were unfinished, so Namzu tidied them before replying'
	return `${lead}${detail}. Check anything those steps touched before running them again.`
}

/** The plain sentence, with the kernel's own wording after it only when detail was asked for. */
export function withDebugDetail(plain: string, raw: string, debug: boolean): string {
	return debug && raw.trim() !== '' ? `${plain}\n${raw}` : plain
}
