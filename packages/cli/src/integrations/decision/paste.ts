/**
 * Read what a person pastes to connect an Azure AI Foundry resource.
 *
 * The portal's "Keys and Endpoint" page copies as loose text: a label, then a value on the
 * next line (or after a colon or an equals sign), with two keys and a region beside the
 * endpoint. The terminal's one-line field also folds a pasted block into one line, so the
 * text is read as a run of words, not as lines. A person may as well paste only the
 * endpoint, only a key, or a target URI that carries the deployment. Whatever is found is
 * returned and the rest is left out for the caller to ask for.
 */

export interface ParsedAzurePaste {
	/** `https://<resource>.services.ai.azure.com` or `https://<resource>.cognitiveservices.azure.com`, no path. */
	readonly endpoint?: string
	readonly key?: string
	readonly deployment?: string
}

const ENDPOINT_PATTERN =
	/https:\/\/[a-z0-9][a-z0-9-]*\.(?:services\.ai|cognitiveservices)\.azure\.com/i
const DEPLOYMENT_IN_URL = /\/deployments\/([A-Za-z0-9][A-Za-z0-9._-]*)/
/** An unbroken run long enough that it is not a word. */
const KEY_SHAPE = /^[A-Za-z0-9+/_=-]{20,}$/

export function normalizeAzureEndpoint(text: string): string | undefined {
	const match = ENDPOINT_PATTERN.exec(text)
	return match ? match[0].toLowerCase() : undefined
}

function strip(token: string): string {
	return token.replace(/^["'`([{]+|["'`,;)\]}]+$/g, '')
}

function isUrl(token: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(token)
}

/** Words of the text, with `label:value` and `label=value` split in two (a URL is kept whole). */
function words(text: string): string[] {
	const out: string[] = []
	for (const raw of text.split(/\s+/)) {
		const token = strip(raw)
		if (token.length === 0) continue
		if (isUrl(token)) {
			out.push(token)
			continue
		}
		const at = token.search(/[:=]/)
		if (at > 0 && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(token.slice(0, at))) {
			const rest = strip(token.slice(at + 1))
			if (rest === '' && token[at] === ':') out.push(token.slice(0, at))
			// Trailing `=` is base64 padding, not a separator.
			else if (rest === '' || /^=+$/.test(rest)) out.push(token)
			else out.push(token.slice(0, at), rest)
		} else out.push(token)
	}
	return out
}

function looksLikeKey(token: string): boolean {
	return KEY_SHAPE.test(token) && !isUrl(token) && /[0-9]/.test(token)
}

export function parseAzurePaste(input: string): ParsedAzurePaste {
	const endpoint = normalizeAzureEndpoint(input)
	let deployment = DEPLOYMENT_IN_URL.exec(input)?.[1]
	const tokens = words(input)

	const labelled: { rank: number; value: string }[] = []
	for (let i = 0; i < tokens.length; i += 1) {
		const word = (tokens[i] as string).toLowerCase()
		let at = -1
		let rank = 1
		if (
			/^(?:key|apikey|api-key|api_key|subscription-key|ocp-apim-subscription-key)[-_]?([12])?$/.test(
				word,
			)
		) {
			rank = Number(/([12])$/.exec(word)?.[1] ?? 1)
			at = i + 1
		} else if (word === 'api' && (tokens[i + 1] ?? '').toLowerCase() === 'key') {
			at = i + 2
		}
		if (at >= 0) {
			let next = tokens[at]
			// "KEY 1" puts the number in its own word.
			if (next !== undefined && /^[12]$/.test(next)) {
				rank = Number(next)
				next = tokens[at + 1]
			}
			if (next !== undefined && looksLikeKey(next)) labelled.push({ rank, value: next })
		} else if (deployment === undefined && word === 'deployment') {
			let next = tokens[i + 1]
			if (next?.toLowerCase() === 'name') next = tokens[i + 2]
			if (next !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next) && !isUrl(next))
				deployment = next
		}
	}
	labelled.sort((a, b) => a.rank - b.rank)
	// Nothing labelled: the first word that is shaped like a key.
	const key = labelled[0]?.value ?? tokens.find((token) => looksLikeKey(token))

	return {
		...(endpoint !== undefined ? { endpoint } : {}),
		...(key !== undefined ? { key } : {}),
		...(deployment !== undefined ? { deployment } : {}),
	}
}
