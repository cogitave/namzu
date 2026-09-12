/** Stored event wall-clock time, not the time a statement became true. Zero is legacy unknown. */
export function evidenceRecordedAt(value: unknown): number | undefined {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= 8_640_000_000_000_000
		? value
		: undefined
}
