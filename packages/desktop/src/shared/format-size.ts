/**
 * Sizes as a person reads them: "12 KB", "1.2 MB", "3 MB". One style for every file, limit and
 * download on screen, in the main process and in the window alike. Units are 1024 apart, which is
 * how the limits are set, so a 3 MB limit reads as exactly "3 MB".
 */
export function formatSize(bytes: number): string {
	const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
	if (value < 1024) return `${Math.round(value)} B`
	if (value < 1024 * 1024) return `${Math.max(1, Math.ceil(value / 1024))} KB`
	const unit = value < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3
	const amount = value / unit
	// Rounded up, so a file one byte over a limit never reads as equal to it.
	const rounded = amount >= 10 ? Math.ceil(amount - 1e-9) : Math.ceil(amount * 10 - 1e-9) / 10
	const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
	return `${text} ${unit === 1024 ** 2 ? 'MB' : 'GB'}`
}

/** A file name that fits a sentence: the start and the extension stay, the middle becomes an ellipsis. */
export function shortFileName(name: string, max = 40): string {
	const chars = Array.from(name)
	if (chars.length <= max) return name
	const dot = name.lastIndexOf('.')
	const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
	const tail = Array.from(extension).length + 6
	const head = Math.max(8, max - tail - 1)
	return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}
