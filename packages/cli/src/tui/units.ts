/** Small unit formatters shared by the live region and the transcript. Pure; no Ink. */

/** `420ms` → `0.4s`, `3210ms` → `3.2s`, `12000ms` → `12s`, `83000ms` → `1m23s`. */
export function formatElapsed(ms: number): string {
	const s = ms / 1000
	if (s < 10) return `${s.toFixed(1)}s`
	if (s < 60) return `${Math.round(s)}s`
	const m = Math.floor(s / 60)
	return `${m}m${Math.round(s - m * 60)}s`
}

/** `950` → `950`, `1100` → `1.1k`, `2_500_000` → `2.50M`. */
export function formatCompactCount(value: number): string {
	if (value < 1_000) return String(value)
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
	return `${(value / 1_000_000).toFixed(2)}M`
}
