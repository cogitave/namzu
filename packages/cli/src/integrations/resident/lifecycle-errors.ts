/**
 * The callback has finished awaiting cleanup, but cannot certify that every
 * owned resource drained. A managed runner must retain its ownership record.
 * Latch this error at the step boundary: cancellation may hide it at the host.
 */
export class ResidentCleanupUnconfirmedError extends AggregateError {
	constructor(errors: readonly unknown[]) {
		super(
			errors,
			[
				'Resident cleanup is unconfirmed; runner ownership must be retained.',
				...errors.map((error) =>
					(error instanceof Error ? error.message : String(error)).slice(0, 4_000),
				),
			].join('\n'),
		)
		this.name = 'ResidentCleanupUnconfirmedError'
	}
}
