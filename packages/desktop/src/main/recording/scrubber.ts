/**
 * What a recording never keeps from text: tokens that look like secrets. It runs on every `text` and
 * `say` event before it is stored, so a secret typed into an ordinary field or spoken aloud never
 * reaches the review sheet, let alone the model. Best effort, which is why the chooser also warns.
 */

export const REMOVED = '[removed]'

const KNOWN_PREFIXES = [
	/^sk-/i,
	/^sk_/i,
	/^ghp_/,
	/^gho_/,
	/^ghs_/,
	/^github_pat_/,
	/^xox[abprs]-/i,
	/^AKIA[0-9A-Z]{8,}/,
	/^AIza[0-9A-Za-z_-]{10,}/,
	/^eyJ[A-Za-z0-9_-]{10,}\./,
]

function entropy(token: string): number {
	const counts = new Map<string, number>()
	for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
	let bits = 0
	for (const count of counts.values()) {
		const p = count / token.length
		bits -= p * Math.log2(p)
	}
	return bits
}

/** A long run of letters, digits and the few symbols keys use, mixing classes, with high entropy. */
export function looksLikeSecretToken(token: string): boolean {
	const bare = token.replace(/^[("'`[{<]+|[)"'`\]}>.,;:!?]+$/g, '')
	if (KNOWN_PREFIXES.some((prefix) => prefix.test(bare)) && bare.length >= 8) return true
	if (bare.length < 24) return false
	if (!/^[A-Za-z0-9+/_=.-]+$/.test(bare)) return false
	const classes =
		Number(/[a-z]/.test(bare)) + Number(/[A-Z]/.test(bare)) + Number(/[0-9]/.test(bare))
	if (classes < 2 || !/[0-9]/.test(bare)) return false
	return entropy(bare) >= 3.5
}

function luhn(digits: string): boolean {
	let sum = 0
	let double = false
	for (let index = digits.length - 1; index >= 0; index--) {
		let value = digits.charCodeAt(index) - 48
		if (double) {
			value *= 2
			if (value > 9) value -= 9
		}
		sum += value
		double = !double
	}
	return sum % 10 === 0
}

const CARD = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g

export interface Scrubbed {
	text: string
	redacted: number
}

export function scrub(input: string): Scrubbed {
	let redacted = 0
	let text = input
	if (/-----BEGIN [A-Z ]+-----/.test(text)) {
		// A key block: everything from the header on is dropped.
		text = text.replace(/-----BEGIN [A-Z ]+-----[\s\S]*$/, REMOVED)
		redacted++
	}
	text = text.replace(CARD, (match) => {
		const digits = match.replace(/[ -]/g, '')
		if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match
		redacted++
		return REMOVED
	})
	text = text
		.split(/(\s+)/)
		.map((part) => {
			if (!part || /^\s+$/.test(part) || part === REMOVED) return part
			if (looksLikeSecretToken(part)) {
				redacted++
				return REMOVED
			}
			return part
		})
		.join('')
	return { text, redacted }
}
