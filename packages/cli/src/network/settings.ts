/**
 * How this process reaches the network: a proxy, hosts that skip it, and an
 * optional client certificate, all read from the environment.
 *
 * Pure and cheap on purpose. The command shell asks `usesCustomNetwork` on
 * every start, before it knows which command will run, and only a yes pays for
 * loading the HTTP client library (`./install.js`).
 *
 * The variables are the ones every command-line tool reads:
 *   HTTPS_PROXY / https_proxy   the proxy for https:// addresses
 *   HTTP_PROXY  / http_proxy    the proxy for http:// addresses (and for https://
 *                               ones when HTTPS_PROXY is not set)
 *   NO_PROXY    / no_proxy      hosts that skip the proxy: comma or space
 *                               separated, a leading dot or `*.` matches
 *                               subdomains, `host:port` limits it to one port,
 *                               `*` skips the proxy for everything
 *   NAMZU_CLIENT_CERT           PEM file with the client certificate
 *   NAMZU_CLIENT_KEY            PEM file with its private key (optional when
 *                               the certificate file holds the key too)
 *   NAMZU_CLIENT_KEY_PASSPHRASE the key's passphrase, if it has one
 * Extra certificate authorities are Node's own `NODE_EXTRA_CA_CERTS`, which
 * Node reads when the process starts; nothing here re-implements it.
 */

export interface NetworkProblem {
	/** The variable that was wrong. */
	readonly variable: string
	/** A sentence for a person; never the variable's value, which can hold a password. */
	readonly message: string
}

export interface NetworkSettings {
	readonly httpProxy?: string
	readonly httpsProxy?: string
	readonly noProxy?: string
	/** Path of the client certificate file. */
	readonly clientCert?: string
	/** Path of the client key file, when it is a file of its own. */
	readonly clientKey?: string
	readonly problems: readonly NetworkProblem[]
}

type Env = Readonly<Record<string, string | undefined>>

/** The first variable of these that is set to something other than blanks. */
function firstSet(env: Env, names: readonly string[]): { name: string; value: string } | undefined {
	for (const name of names) {
		const value = env[name]?.trim()
		if (value) return { name, value }
	}
	return undefined
}

/** A proxy address with a scheme, or why it cannot be used. */
function proxyAddress(
	found: { name: string; value: string } | undefined,
	problems: NetworkProblem[],
): string | undefined {
	if (!found) return undefined
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(found.value)
		? found.value
		: `http://${found.value}`
	try {
		const url = new URL(withScheme)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			problems.push({
				variable: found.name,
				message: `${found.name} names a ${url.protocol.slice(0, -1)} proxy, which Namzu cannot use, so it is ignored. Use an http or https proxy address such as http://host:3128.`,
			})
			return undefined
		}
		if (!url.hostname) throw new Error('no host')
		return withScheme
	} catch {
		problems.push({
			variable: found.name,
			message: `${found.name} is not a proxy address Namzu can read, so it is ignored. Write it like http://host:3128.`,
		})
		return undefined
	}
}

/** Both spellings of NO_PROXY as one list; `*` in either wins. */
function noProxyList(env: Env): string | undefined {
	const upper = env.NO_PROXY?.trim()
	const lower = env.no_proxy?.trim()
	if (upper === '*' || lower === '*') return '*'
	const parts = [upper, lower].filter((part): part is string => Boolean(part))
	if (parts.length === 2 && parts[0] === parts[1]) return parts[0]
	return parts.length > 0 ? parts.join(',') : undefined
}

export function readNetworkSettings(env: Env): NetworkSettings {
	const problems: NetworkProblem[] = []
	const httpProxy = proxyAddress(firstSet(env, ['HTTP_PROXY', 'http_proxy']), problems)
	const httpsProxy = proxyAddress(firstSet(env, ['HTTPS_PROXY', 'https_proxy']), problems)
	const noProxy = noProxyList(env)
	const clientCert = env.NAMZU_CLIENT_CERT?.trim() || undefined
	const clientKey = env.NAMZU_CLIENT_KEY?.trim() || undefined
	if (clientKey && !clientCert) {
		problems.push({
			variable: 'NAMZU_CLIENT_KEY',
			message:
				'NAMZU_CLIENT_KEY is set without NAMZU_CLIENT_CERT, so no client certificate is sent. Set both.',
		})
	}
	return {
		...(httpProxy ? { httpProxy } : {}),
		...(httpsProxy ? { httpsProxy } : {}),
		...(noProxy ? { noProxy } : {}),
		...(clientCert ? { clientCert } : {}),
		...(clientKey && clientCert ? { clientKey } : {}),
		problems,
	}
}

/**
 * Whether anything here changes how connections are made. False for the
 * ordinary machine, which then never loads the HTTP client library.
 */
export function usesCustomNetwork(env: Env): boolean {
	const settings = readNetworkSettings(env)
	return Boolean(
		settings.httpProxy ||
			settings.httpsProxy ||
			settings.clientCert ||
			settings.problems.length > 0,
	)
}

/** A proxy address as it may be shown: the host and port, never the credentials. */
export function proxyHost(address: string): string {
	try {
		return new URL(address).host
	} catch {
		return 'the proxy'
	}
}
