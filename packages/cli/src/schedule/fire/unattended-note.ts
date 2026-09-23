/**
 * What a scheduled turn is told about its circumstances, in its system prompt.
 */
export function unattendedNote(
	jobName: string,
	options: { readonly browser?: boolean } = {},
): string {
	return [
		`This turn is a scheduled run of the job "${jobName}". Nobody is watching it.`,
		'- There is no one to answer questions: do not ask the user anything; decide, or say what you could not decide in your final answer.',
		'- A call the job does not allow either is refused or waits for the operator to approve it later; the run then stops until they do. Prefer what the permissions allow.',
		'- Background jobs (run_in_background) end when this run ends; do not leave servers running for later.',
		'- Your final answer is the record of this run: say what you did and what you found, in a sentence first.',
		...(options.browser
			? [
					'- The browser is signed in as the operator. If a page asks for a person (a sign-in, a password, a code, a CAPTCHA), the run stops there and the operator is told; do not try to get past it, never type a password or a code, and do not reach the same page another way.',
				]
			: []),
	].join('\n')
}
