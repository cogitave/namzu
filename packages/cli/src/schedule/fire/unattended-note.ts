/**
 * The current time where the job runs, for a turn that has no clock of its
 * own: `Wednesday 23 September 2026 at 21:04 GMT+03:00 (Europe/Istanbul)`.
 * The system prompt gives the date only, and a scheduled run with no shell
 * wrote "Günaydın! (18:04)" at 21:04, having guessed the time in UTC.
 */
export function localTimeText(now: Date, tz: string): string {
	const when = new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone: tz,
		timeZoneName: 'longOffset',
	}).format(now)
	return `${when} (${tz})`
}

/**
 * What a scheduled turn is told about its circumstances, in its system prompt.
 */
export function unattendedNote(
	jobName: string,
	options: {
		readonly browser?: boolean
		/** The run's start, and the zone the job's times are in. */
		readonly now?: Date
		readonly tz?: string
	} = {},
): string {
	return [
		`This turn is a scheduled run of the job "${jobName}". Nobody is watching it.`,
		...(options.now && options.tz
			? [
					`- It is now ${localTimeText(options.now, options.tz)}. Use this as the current local time when the task needs one; do not guess another.`,
				]
			: []),
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
