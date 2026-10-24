/** Small unit formatters shared by the live region and the transcript. Pure; no Ink. */

/**
 * The reference's duration format, seconds floored: `420ms` → `0s`,
 * `3210ms` → `3s`, `12000ms` → `12s`, `83000ms` → `1m 23s`,
 * `7384000ms` → `2h 3m 4s`, one space between units.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	if (total < 60) return `${total}s`
	const seconds = total % 60
	const minutes = Math.floor(total / 60) % 60
	const hours = Math.floor(total / 3600) % 24
	const days = Math.floor(total / 86_400)
	if (days > 0) return `${days}d ${hours}h ${minutes}m`
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
	return `${minutes}m ${seconds}s`
}

/** `950` → `950`, `1100` → `1.1k`, `2_500_000` → `2.50M`. */
export function formatCompactCount(value: number): string {
	if (value < 1_000) return String(value)
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
	return `${(value / 1_000_000).toFixed(2)}M`
}
