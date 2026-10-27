/**
 * Plain words for a child's failure. A refusal written for a host that embeds
 * the kernel (it names ids and log contracts) means nothing to a person
 * watching a row, so it is replaced by what happened and what to do; every
 * other message is kept as the child said it.
 */
const HISTORY_CONTRACT = /^A cached message\b/

export function plainChildFailure(text: string): string {
	const trimmed = text.trim()
	if (HISTORY_CONTRACT.test(trimmed))
		return 'It could not continue from the conversation it was given. Try the request again.'
	return trimmed
}
