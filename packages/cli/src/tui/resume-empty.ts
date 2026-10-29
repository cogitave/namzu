/**
 * What `/resume` says when it has no conversation to offer.
 *
 * The list leaves out the conversation that is already open, so an empty list
 * has two causes a person needs told apart: there are no conversations here at
 * all, or the only one is the one on screen.
 */
export function noResumeText(input: {
	/** What was typed after `/resume`, trimmed; empty for the plain command. */
	readonly query: string
	/** Whether the folder holds any conversation, the open one included. */
	readonly anyHere: boolean
	/** `--from-pr`: the list was narrowed to conversations linked to a pull request. */
	readonly pr?: { readonly kind: 'any' } | { readonly kind: 'number'; readonly number: number }
}): string {
	if (input.pr !== undefined) {
		return input.pr.kind === 'number'
			? `No conversation in this folder is linked to pull request #${input.pr.number}.`
			: 'No conversation in this folder is linked to a pull request yet. One is linked when it opens or changes a pull request.'
	}
	if (input.query.length > 0) {
		return `No other conversation in this folder matches "${input.query}". /resume lists them all.`
	}
	return input.anyHere
		? 'The only conversation in this folder is the one already open.'
		: 'No past conversations to resume in this folder yet.'
}
