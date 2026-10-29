/**
 * A leading `sleep` of this many seconds or more is refused where a better
 * way to wait exists (a background job to wait on, or a monitor).
 */
export const LONG_SLEEP_SECONDS = 25

/**
 * Describes the long wait a command opens with, or `null` when it does not
 * open with one. Only a first sub-command that is exactly `sleep <seconds>`
 * counts; a sleep in the middle of a chain, or a suffixed one (`sleep 30s`),
 * is left alone.
 */
export function leadingLongSleep(command: string): string | null {
	const parts = command
		.split(/&&|\|\||;|\||\n/)
		.map((part) => part.trim())
		.filter((part) => part !== '')
	const head = parts[0]
	if (head === undefined) return null
	const match = /^sleep\s+(\d+(?:\.\d*)?)$/.exec(head)
	if (!match) return null
	const seconds = Number.parseFloat(match[1] ?? '')
	if (!(seconds >= LONG_SLEEP_SECONDS)) return null
	const rest = parts.slice(1).join(' ').trim()
	return rest ? `sleep ${seconds} followed by: ${rest}` : `standalone sleep ${seconds}`
}

/** What the model is told when a long leading sleep is refused. */
export function longSleepRefusal(what: string): string {
	return `Blocked: ${what}. To wait for a condition, use the monitor tool with an until-loop (for example \`until <check>; do sleep 2; done\`). To wait for a command you started, use run_in_background: true and then wait_for_job. Do not chain shorter sleeps to work around this block.`
}
