/**
 * Every time and date the transcript shows comes from here, in the operating system's locale and
 * its own 12- or 24-hour habit. Nothing forces `hour12` or a second locale, so a header, a message
 * footer and a tooltip never disagree about how this person reads the clock.
 */
type Locale = string | string[] | undefined

/** `6:27 AM` or `06:27`, whichever the locale uses. No seconds: the tooltip has them. */
export function clockLabel(at: number, locale?: Locale): string {
	return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
		new Date(at),
	)
}

/** The date and the time with seconds, for a tooltip or an accessible name. */
export function fullTimeLabel(at: number, locale?: Locale): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
		new Date(at),
	)
}

/** The header between two days of a conversation: weekday, day, month and the clock. */
export function daySeparatorLabel(at: number, locale?: Locale): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(at))
}
