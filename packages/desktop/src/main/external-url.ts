/** System browser links are explicit user actions and never privileged renderer navigation. */
export function externalSourceUrl(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length > 8_192 ||
		[...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
	)
		throw new Error('Invalid source link.')
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('Invalid source link.')
	}
	if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password)
		throw new Error('Only web source links can be opened.')
	return url.href
}
