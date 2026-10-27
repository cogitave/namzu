/**
 * The one row that says a reply is paused while it mends itself.
 *
 * Every failed try of one run rewrites that row instead of adding another.
 * The run ends when the try counter goes back to zero or when a pause of a
 * different kind is pushed; from then on the row is history and a later pause
 * gets a row of its own.
 */
export class SelfMendingPauseRow {
	#id: string | null = null

	/** The row to rewrite, or null when this try must push a new one. */
	reusable(attempt: number, rowIds: ReadonlySet<string>): string | null {
		if (this.#id === null || attempt <= 0) return null
		return rowIds.has(this.#id) ? this.#id : null
	}

	remember(id: string): void {
		this.#id = id
	}

	/** The run ended: the counter reset, or another kind of pause took over. */
	forget(): void {
		this.#id = null
	}
}
