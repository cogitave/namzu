/**
 * Give retained text its own backing storage instead of keeping a source slice
 * alive. Call only after bounding the text: copying a whole tool result would
 * briefly double its memory. UTF-16 preserves every JavaScript code unit,
 * including lone surrogates that a UTF-8 round trip would replace.
 *
 * @internal
 */
export function copyString(text: string): string {
	return Buffer.from(text, 'utf16le').toString('utf16le')
}
