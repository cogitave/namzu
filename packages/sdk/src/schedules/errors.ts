/**
 * A schedule, cron expression or time zone that cannot be used.
 *
 * `token` names the piece of the input that was refused, so a caller can
 * point at it instead of repeating the whole expression back.
 */
export class ScheduleValidationError extends Error {
	readonly token: string | undefined

	constructor(message: string, token?: string) {
		super(message)
		this.name = 'ScheduleValidationError'
		this.token = token
	}
}
