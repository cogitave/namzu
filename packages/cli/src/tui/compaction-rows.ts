/**
 * What the transcript says about compaction, in plain words.
 *
 * The transcript says three short things: while it works, "Compacting
 * conversation…"; afterwards, "Conversation compacted (ctrl+o for history)";
 * and when it cannot, "Compaction failed · conversation could not be reduced
 * below the context limit". Everything else (message counts, token estimates,
 * the summary itself, what the reducer threw) is reachable but not in the way.
 */

import { withDebugDetail } from './capability-notice.js'

/** The live row while a compaction runs. */
export const COMPACTING_LABEL = 'Compacting conversation…'

/** The row a compaction leaves in the transcript. */
export const COMPACTED_TEXT = 'Conversation compacted'
/** Dim hint after it: the counts sit behind Ctrl+O. */
export const COMPACTED_HINT = '(ctrl+o for history)'

/** The result of `/compact`: the summary sits behind Ctrl+O. */
export const COMPACT_RESULT_TEXT = 'Compacted'
export const COMPACT_RESULT_HINT = '(ctrl+o to see full summary)'

/** What `/compact` says when there is nothing worth summarising. */
export const NOTHING_TO_COMPACT_TEXT =
	'Nothing to compact yet. The conversation is still short enough.'

/** Why a `/compact` row may need to say the summary was not saved. */
export const COMPACT_NOT_SAVED_TEXT =
	'This conversation could not be saved, so the summary lasts only until you quit.'

function approximate(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

/**
 * The lines behind Ctrl+O on an automatic compaction: what was replaced by
 * what. Kept out of the row itself, so the transcript reads as one calm line.
 */
export function compactionHistoryLines(event: {
	readonly messagesBefore: number
	readonly messagesAfter: number
	readonly tokensBefore: number
	readonly tokensAfter: number
	readonly measuredBy: 'provider' | 'estimate'
}): readonly string[] {
	const messages = (n: number) => `${n} message${n === 1 ? '' : 's'}`
	const about = event.measuredBy === 'estimate' ? 'about ' : ''
	return [
		`${messages(event.messagesBefore)} became ${messages(event.messagesAfter)}.`,
		`Context went from ${about}${approximate(event.tokensBefore)} to ${about}${approximate(event.tokensAfter)} tokens.`,
	]
}

/**
 * The summary as shown to a person: the marker the model reads to recognise
 * a summary is for the model, so it is dropped from what is displayed.
 */
export function stripCompactionMarker(text: string): string {
	return text.replace(/^\[COMPACTED CONTEXT\][^\n]*\n*/u, '').trimStart()
}

/** The summary lines under a compaction row; an empty summary says so. */
export function compactionSummaryLines(text: string): readonly string[] {
	const body = stripCompactionMarker(text).trimEnd()
	return body.length > 0 ? body.split('\n') : ['(the summary was empty)']
}

/** The causes a compaction can decline for, as the runtime names them. */
export type CompactionFailureCause =
	| 'reducer_threw'
	| 'shed_nothing'
	| 'split_tool_pair'
	| 'breaker_open'
	| 'refilling'

/**
 * One sentence per failure, with what happens next. The runtime's own error
 * text follows only when debug detail was asked for.
 */
export function describeCompactionFailure(
	event: { readonly cause: CompactionFailureCause; readonly error?: string },
	debug: boolean,
): string {
	switch (event.cause) {
		case 'reducer_threw':
			return withDebugDetail(
				'Compaction failed · the summary could not be written. Your conversation is unchanged and Namzu will try again.',
				event.error ?? '',
				debug,
			)
		case 'shed_nothing':
			return 'Compaction failed · conversation could not be reduced below the context limit. Your conversation is unchanged; a large file or tool output is probably filling it, so try reading it in smaller parts.'
		case 'split_tool_pair':
			return withDebugDetail(
				'Compaction failed · the summary could not be used. Your conversation is unchanged.',
				event.error ?? '',
				debug,
			)
		case 'breaker_open':
			// Never shown (the mapper returns no row for it); kept so the switch stays exhaustive.
			return 'Automatic compaction is paused for this reply after repeated attempts that freed nothing.'
		case 'refilling':
			return withDebugDetail(
				'The context filled up again right after being compacted, three times in a row. A file being read or a tool output is probably too large. Try reading it in smaller parts.',
				event.error ?? '',
				debug,
			)
	}
}
