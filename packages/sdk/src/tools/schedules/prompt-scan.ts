/**
 * A tripwire over a scheduled prompt, run when the job is proposed.
 *
 * A scheduled prompt runs later with nobody watching, so a prompt that hides
 * characters, tells the model to ignore its instructions, or reads secrets and
 * sends them somewhere deserves a second look before anyone confirms it.
 * Findings are shown to the person confirming; they never block on their own,
 * because the operator may mean exactly what they wrote.
 */

/** Characters that render as nothing or reorder what is shown. */
/** Invisible and direction-changing code point ranges, inclusive. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
	[0x200b, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0xfeff, 0xfeff],
	[0x00ad, 0x00ad],
]

function isInvisible(code: number): boolean {
	return INVISIBLE_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

function hasInvisible(text: string): boolean {
	for (const ch of text) if (isInvisible(ch.codePointAt(0) ?? 0)) return true
	return false
}

/** C0 controls other than tab, newline and carriage return, and DEL. */
function isControl(code: number): boolean {
	return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f
}

function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (isControl(text.charCodeAt(i))) return true
	return false
}

const DIRECTIVES: readonly RegExp[] = [
	/\bignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|messages)\b/i,
	/\bdisregard (all |any )?(the )?(previous|prior|above|system) /i,
	/\b(reveal|print|show|repeat) (your|the) (system prompt|instructions)\b/i,
	/\byou are no longer\b/i,
]

const SECRET_READS: readonly RegExp[] = [
	/~?\/?\.ssh\b|\bid_(rsa|ed25519|ecdsa)\b/i,
	/\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.netrc\b|\.npmrc\b|\.pypirc\b/i,
	/\bcredentials\.json\b|\.env\b/i,
	/\b(printenv|env)\b\s*($|[|;&>])/i,
	/\b[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD)\b/,
]

const EXFILTRATION: readonly RegExp[] = [
	/\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/i,
	/\bcurl\b[^\n]*\s(-d|--data(-binary|-raw)?|-F|--form|-T|--upload-file|-X\s*(POST|PUT))\b/i,
	/\b(nc|ncat|netcat|socat)\b\s+\S+\s+\d+/i,
	/\bbase64\b[^\n]*\|\s*(curl|wget|nc)\b/i,
]

/** What the scan found, as sentences for the confirmation screen. Empty when nothing. */
export function scanSchedulePrompt(prompt: string): string[] {
	const findings: string[] = []
	if (hasInvisible(prompt)) {
		findings.push('The prompt contains invisible or direction-changing characters.')
	}
	if (hasControl(prompt)) findings.push('The prompt contains control characters.')
	if (DIRECTIVES.some((re) => re.test(prompt))) {
		findings.push('The prompt tells the model to ignore or reveal its instructions.')
	}
	if (SECRET_READS.some((re) => re.test(prompt))) {
		findings.push('The prompt mentions credentials, keys or secret files.')
	}
	if (EXFILTRATION.some((re) => re.test(prompt))) {
		findings.push('The prompt pipes a download into a shell or sends data to a remote address.')
	}
	return findings
}

/**
 * The prompt with every invisible and control character made visible as
 * `<U+XXXX>`, so the person confirming sees what the model will read.
 */
export function revealHiddenCharacters(prompt: string): string {
	let out = ''
	for (const ch of prompt) {
		const code = ch.codePointAt(0) ?? 0
		out +=
			isControl(code) || isInvisible(code)
				? `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
				: ch
	}
	return out
}
