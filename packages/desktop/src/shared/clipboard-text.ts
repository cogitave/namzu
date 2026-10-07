/** Clipboard writes are bounded and never silently truncate authored text. */
export const MAX_COPY_TEXT_BYTES = 4 * 1024 * 1024

export function copyTextPayload(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Copy requires plain text.')
	if (value.length > MAX_COPY_TEXT_BYTES) throw new Error('The text exceeds the 4 MiB copy limit.')
	// Native text clipboards terminate at NUL. Invalid UTF-16 would also be
	// replaced on UTF-8 conversion, so neither can promise an exact text copy.
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index)
		if (unit === 0) throw new Error('This text cannot be copied without truncation.')
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index)
			if (!(next >= 0xdc00 && next <= 0xdfff))
				throw new Error('This text contains an incomplete Unicode character.')
		} else if (unit >= 0xdc00 && unit <= 0xdfff)
			throw new Error('This text contains an incomplete Unicode character.')
	}
	if (new TextEncoder().encode(value).byteLength > MAX_COPY_TEXT_BYTES)
		throw new Error('The text exceeds the 4 MiB copy limit.')
	return value
}
