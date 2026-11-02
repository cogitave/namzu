// Not imported from the driver: this module is read at launch, and loading the
// driver package for a hostname comparison would cost the start-up it saves.
const VENDOR_HOST = 'api.anthropic.com'

/** Where the Anthropic-wire driver sends requests, read from the standard environment. */
export interface AnthropicEndpoint {
	readonly baseURL: string
	readonly host: string
	/** True when the host is the vendor's own, so saved sign-ins may be used on it. */
	readonly vendor: boolean
	/** `ANTHROPIC_AUTH_TOKEN`, sent as a bearer token. */
	readonly authToken?: string
	/** `ANTHROPIC_API_KEY`, sent as the vendor's key header. */
	readonly apiKey?: string
}

/**
 * `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are the vendor SDK's own
 * variables, honoured so an Anthropic-compatible service works the way its
 * documentation tells operators to configure it. Undefined when no base URL is
 * set; throws for one that is not an http(s) URL, because a typo that silently
 * fell back to the vendor would send the prompt to the wrong place.
 */
export function readAnthropicEndpoint(
	env: NodeJS.ProcessEnv = process.env,
): AnthropicEndpoint | undefined {
	const raw = env.ANTHROPIC_BASE_URL?.trim()
	if (!raw) return undefined
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error('ANTHROPIC_BASE_URL must be a full http or https URL.')
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new Error('ANTHROPIC_BASE_URL must be a full http or https URL.')
	const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined
	const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined
	return {
		baseURL: raw,
		host: url.host,
		vendor: url.hostname === VENDOR_HOST,
		...(authToken ? { authToken } : {}),
		...(apiKey ? { apiKey } : {}),
	}
}

/** The host to show an operator, only when requests go somewhere other than the vendor. */
export function thirdPartyHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
	try {
		const endpoint = readAnthropicEndpoint(env)
		return endpoint && !endpoint.vendor ? endpoint.host : undefined
	} catch {
		return undefined
	}
}
