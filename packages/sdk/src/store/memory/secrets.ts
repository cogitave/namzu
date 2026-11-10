/**
 * Secret shapes: text that looks like a credential and must not be written to
 * a memory. A memory is recalled into later prompts, sent to providers and
 * kept on disk in the clear, so a key saved once is a key leaked many times.
 *
 * The match is on shape only. It names a reason code and never returns the
 * matched text, so a caller can log the code without logging the secret.
 */

export type SecretShape =
	| 'private_key'
	| 'provider_token'
	| 'jwt'
	| 'credentialed_url'
	| 'high_entropy'

const PATTERNS: readonly (readonly [SecretShape, RegExp])[] = [
	['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
	[
		'provider_token',
		new RegExp(
			[
				'\\bsk-(?:ant-|proj-|live-|or-v1-)?[A-Za-z0-9_-]{20,}',
				'\\bgh[pousr]_[A-Za-z0-9]{30,}',
				'\\bgithub_pat_[A-Za-z0-9_]{30,}',
				'\\bglpat-[A-Za-z0-9_-]{16,}',
				'\\bxox[abposr]-[A-Za-z0-9-]{10,}',
				'\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b',
				'\\bAIza[A-Za-z0-9_-]{35}\\b',
				'\\bnvapi-[A-Za-z0-9_-]{20,}',
				'\\bnpm_[A-Za-z0-9]{30,}',
				'\\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}',
				'\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
				'\\bhf_[A-Za-z0-9]{30,}',
				'\\bBearer\\s+[A-Za-z0-9._~+/-]{24,}=*',
			].join('|'),
		),
	],
	['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
	['credentialed_url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
]

/** Shannon entropy of `text`, in bits per character. */
function entropy(text: string): number {
	const counts = new Map<string, number>()
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
	let bits = 0
	for (const n of counts.values()) {
		const p = n / text.length
		bits -= p * Math.log2(p)
	}
	return bits
}

/** How many times the token switches between a letter and a digit. */
function letterDigitSwitches(token: string): number {
	let switches = 0
	let previous: 'letter' | 'digit' | undefined
	for (const ch of token) {
		const kind = /\d/.test(ch) ? 'digit' : /[A-Za-z]/.test(ch) ? 'letter' : undefined
		if (kind === undefined) continue
		if (previous !== undefined && previous !== kind) switches += 1
		previous = kind
	}
	return switches
}

/**
 * Random, not merely long: a long identifier with a trailing number
 * (`DecisionsAbcDefGhi1234567890`) has mixed case and a digit but few
 * letter-digit switches and a low spread, a key has both. A path-like token
 * is a path.
 */
function looksRandom(token: string): boolean {
	return (
		!token.includes('/') &&
		/[A-Z]/.test(token) &&
		/[a-z]/.test(token) &&
		letterDigitSwitches(token) >= 4 &&
		entropy(token) >= 4.5
	)
}

export interface SecretScanOptions {
	/**
	 * Also flag a long unbroken run of mixed-case letters and digits that looks
	 * random. Off by default: it can flag an identifier a person meant to keep,
	 * which is right for text nobody chose and wrong for text somebody did.
	 */
	readonly entropy?: boolean
}

/** The first secret shape `text` has, or `undefined`. */
export function findSecretShape(
	text: string,
	options: SecretScanOptions = {},
): SecretShape | undefined {
	for (const [shape, pattern] of PATTERNS) if (pattern.test(text)) return shape
	if (options.entropy === true) {
		for (const token of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
			if (looksRandom(token)) return 'high_entropy'
		}
	}
	return undefined
}
