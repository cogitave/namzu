import type {
	EngineDeliveryView,
	EngineProblem,
	EngineRun,
	EngineStatus,
} from '../shared/engine-delivery-protocol.js'

/**
 * The words about the engine the app runs and keeps current. Everything here is a fixed sentence
 * with a version number or a date put in; nothing from the update feed is drawn as text, and a
 * version is cut to a sane length before it is shown. Dates follow the person's own language.
 */

const MAX_VERSION_LENGTH = 40

/** A version number as plain text, never longer than a version can sensibly be. */
export function plainVersion(version: string | undefined): string | undefined {
	if (!version) return undefined
	const clean = Array.from(version)
		.filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
		.join('')
	return clean.length > MAX_VERSION_LENGTH ? `${clean.slice(0, MAX_VERSION_LENGTH)}…` : clean
}

/** `12 Nov` this year, `12 Nov 2025` another year, in the person's language. */
export function shortDate(at: number, now: number, locale?: string): string {
	const date = new Date(at)
	const sameYear = date.getFullYear() === new Date(now).getFullYear()
	return date.toLocaleDateString(locale, {
		day: 'numeric',
		month: 'short',
		...(sameYear ? {} : { year: 'numeric' }),
	})
}

const PROBLEMS: Record<EngineProblem, string> = {
	'did-not-start': 'it did not start',
	'ended-early': 'it kept stopping',
	'failed-checks': 'it did not pass this app’s checks',
}

/** The one quiet line about where the running engine came from. */
export function engineSourceText(run: EngineRun, now: number, locale?: string): string {
	if (run.source === 'override') return 'Developer override.'
	if (run.source === 'managed')
		return run.since !== undefined
			? `Updated by itself on ${shortDate(run.since, now, locale)}.`
			: 'Updated by itself.'
	return 'This app’s own engine.'
}

/** The state of the engine row in Settings > Updates. */
export function engineStatusText(
	status: EngineStatus,
	checkedText: (at: number) => string,
	now: number,
	locale?: string,
): string {
	switch (status.kind) {
		case 'off':
			return 'Off. This app runs the engine it was installed with.'
		case 'override':
			return 'A developer override is in use, so the engine is not updated.'
		case 'unknown':
			return 'Not checked yet.'
		case 'checking':
			return 'Checking for a newer engine…'
		case 'current':
			return `The engine is up to date. Last checked: ${checkedText(status.checkedAt)}.`
		case 'ready':
			return `A newer engine (${plainVersion(status.version)}) is ready. It takes effect the next time a project opens.`
		case 'went-back': {
			const to = plainVersion(status.to)
			return `Could not use engine ${plainVersion(status.version)} (${PROBLEMS[status.problem]})${to ? ` and went back to ${to}` : ''}.`
		}
		case 'needs-newer-app':
			return 'A newer engine is out, but it needs a newer version of this app.'
		case 'cannot-check':
			return `Could not check for a newer engine since ${shortDate(status.since, now, locale)}.`
	}
}

/** Lines for "Copy details": the same facts the screens show, versions and words only. */
export function engineDetailsLines(
	view: EngineDeliveryView,
	now: number,
	locale?: string,
): string[] {
	if (!view.available) return []
	const lines = [`Engine source: ${engineSourceText(view.runs, now, locale)}`]
	if (view.runs.source === 'managed' && view.bundled.commandLine)
		lines.push(
			`Namzu command line (this app’s own, used if the newer one cannot start) ${plainVersion(view.bundled.commandLine)}`,
		)
	lines.push(
		`Engine updates: ${engineStatusText(view.status, (at) => shortDate(at, now, locale), now, locale)}`,
	)
	return lines
}
