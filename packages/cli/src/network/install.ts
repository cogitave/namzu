/**
 * Route this process's outgoing web requests through the proxy the environment
 * names, and present the client certificate it names.
 *
 * Every model provider, the tool-server (MCP) clients and the web tools make
 * their requests with the platform's `fetch`, which sends them through one
 * process-wide dispatcher. This replaces that dispatcher, once, so they all
 * share the same proxy, the same NO_PROXY list and the same certificate, with
 * nothing to configure per client.
 */

import { readFileSync, statSync } from 'node:fs'

import { type NetworkSettings, proxyHost, readNetworkSettings } from './settings.js'

/** A certificate or key file is a few kilobytes; this refuses something that is not one. */
const MAX_PEM_BYTES = 1_048_576

/**
 * Addresses that never leave this machine. A proxy is for the outside world, and
 * a local engine (Ollama, a tool server on loopback) must keep working on a
 * machine that sets HTTP_PROXY for everything else, as it did before proxies
 * were read at all.
 */
const LOOPBACK = 'localhost,127.0.0.1,[::1]'

export interface NetworkInstall {
	/** The dispatcher was replaced. False when nothing asked for it. */
	readonly installed: boolean
	/** What was found wrong with the settings, in sentences for a person. */
	readonly problems: readonly string[]
}

/** The two things this needs from the HTTP client library, so a test can stand in for it. */
export interface DispatcherLibrary {
	readonly EnvHttpProxyAgent: new (options: Record<string, unknown>) => unknown
	readonly setGlobalDispatcher: (dispatcher: never) => void
}

export interface InstallOptions {
	readonly env?: Readonly<Record<string, string | undefined>>
	/** Where a problem is said. Defaults to one line each on stderr. */
	readonly report?: (message: string) => void
	readonly library?: DispatcherLibrary
}

function readPem(variable: string, path: string, problems: string[]): string | undefined {
	try {
		const info = statSync(path)
		if (!info.isFile() || info.size > MAX_PEM_BYTES) throw new Error('not a certificate file')
		const text = readFileSync(path, 'utf8')
		if (!text.includes('-----BEGIN ')) throw new Error('no PEM block')
		return text
	} catch {
		problems.push(
			`${variable} does not point to a readable PEM file, so no client certificate is sent.`,
		)
		return undefined
	}
}

/** The client-certificate options for a connection, or undefined when none is set or readable. */
function clientTls(
	settings: NetworkSettings,
	env: Readonly<Record<string, string | undefined>>,
	problems: string[],
): Record<string, string> | undefined {
	if (!settings.clientCert) return undefined
	const cert = readPem('NAMZU_CLIENT_CERT', settings.clientCert, problems)
	if (!cert) return undefined
	let key: string | undefined
	if (settings.clientKey) {
		key = readPem('NAMZU_CLIENT_KEY', settings.clientKey, problems)
		if (!key) return undefined
	}
	const passphrase = env.NAMZU_CLIENT_KEY_PASSPHRASE
	return {
		cert,
		...(key ? { key } : {}),
		...(passphrase ? { passphrase } : {}),
	}
}

/**
 * The HTTP client library, whichever way the module system hands it over: its
 * exports are named when it is loaded as a package and sit under `default` once
 * the CLI is bundled into one file.
 */
export async function loadUndici(): Promise<DispatcherLibrary> {
	const loaded = (await import('undici')) as unknown as Record<string, unknown>
	if ('EnvHttpProxyAgent' in loaded) return loaded as unknown as DispatcherLibrary
	const nested = loaded.default
	if (nested && typeof nested === 'object') return nested as DispatcherLibrary
	throw new Error('The HTTP client library did not load.')
}

export async function installNetwork(options: InstallOptions = {}): Promise<NetworkInstall> {
	const env = options.env ?? process.env
	const report =
		options.report ?? ((message: string) => process.stderr.write(`namzu: ${message}\n`))
	const settings = readNetworkSettings(env)
	const problems = settings.problems.map((problem) => problem.message)
	const tls = clientTls(settings, env, problems)
	for (const message of problems) report(message)
	if (!settings.httpProxy && !settings.httpsProxy && !tls) return { installed: false, problems }

	const library = options.library ?? (await loadUndici())
	const dispatcher = new library.EnvHttpProxyAgent({
		// An empty string, not undefined: undefined makes the agent read the
		// environment itself, including a value this module just refused.
		httpProxy: settings.httpProxy ?? '',
		httpsProxy: settings.httpsProxy ?? settings.httpProxy ?? '',
		noProxy:
			settings.noProxy === '*' ? '*' : [settings.noProxy, LOOPBACK].filter(Boolean).join(','),
		...(tls ? { connect: tls, requestTls: tls } : {}),
	})
	library.setGlobalDispatcher(dispatcher as never)
	return { installed: true, problems }
}

/** One line for a person on what this process will use, or null when it connects directly. */
export function describeNetwork(settings: NetworkSettings): string | null {
	const proxy = settings.httpsProxy ?? settings.httpProxy
	const parts: string[] = []
	if (proxy) {
		parts.push(
			`Requests go through the proxy at ${proxyHost(proxy)}${settings.noProxy ? `, except for ${settings.noProxy}` : ''}.`,
		)
	}
	if (settings.clientCert) parts.push('A client certificate is sent.')
	return parts.length > 0 ? parts.join(' ') : null
}
