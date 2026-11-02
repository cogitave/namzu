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

/**
 * The endpoint requests will actually go to, and a one-line notice when
 * `ANTHROPIC_BASE_URL` is set but not used. A base URL is used when it names
 * the vendor's host, or a third party together with a token or key variable.
 * Otherwise (a typo, or a gateway URL exported for another tool with no
 * credential for it) the saved sign-in keeps going to the vendor's own host
 * and the notice says why the variable was ignored; nothing throws.
 */
export function resolveAnthropicEndpoint(env: NodeJS.ProcessEnv = process.env): {
	readonly endpoint?: AnthropicEndpoint
	readonly notice?: string
} {
	let endpoint: AnthropicEndpoint | undefined
	try {
		endpoint = readAnthropicEndpoint(env)
	} catch (error) {
		return {
			notice: `${(error as Error).message} It was ignored, and requests go to the vendor's own host.`,
		}
	}
	if (!endpoint) return {}
	if (!endpoint.vendor && !endpoint.authToken && !endpoint.apiKey)
		return {
			notice: `ANTHROPIC_BASE_URL points at ${endpoint.host}, but neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set, so it was ignored. Saved sign-ins are only sent to the vendor's own host.`,
		}
	return { endpoint }
}

/** The host to show an operator, only when requests go somewhere other than the vendor. */
export function thirdPartyHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const { endpoint } = resolveAnthropicEndpoint(env)
	return endpoint && !endpoint.vendor ? endpoint.host : undefined
}
