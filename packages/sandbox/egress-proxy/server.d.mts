/**
 * Types for `server.mjs`, the egress proxy container's entrypoint.
 *
 * The entrypoint is plain JavaScript, like the other two container-side files
 * in this package (`worker/server.js`, `agent/agent.cjs`): it runs inside an
 * image, not inside this package's build. This declaration exists so that the
 * TypeScript side can import it, which one test does — the test that feeds the
 * backend's own serialisation to the parser the container runs, so the two
 * ends of that boundary are pinned against each other rather than each tested
 * against its own idea of the shape.
 *
 * It is deliberately narrow: only what a caller outside the container has any
 * business calling. `startEgressProxy` and `main` are exercised by
 * `__tests__/server.test.js`, which drives the real file as a subprocess the
 * way the container does.
 */

/** One credential the proxy stamps on, for one host. */
export interface ParsedCredential {
	readonly host: string
	readonly header: string
	readonly value: string
}

/** What `parseProxyConfig` returns: the policy, validated. */
export interface ParsedEgressProxyConfig {
	readonly port: number
	readonly allowedHosts: readonly string[]
	readonly credentials: readonly ParsedCredential[]
	readonly allowInwardFor?: readonly string[]
	readonly upgradeToHttps?: boolean
	readonly selfNames?: readonly string[]
	/** Present only in a V2 configuration: every rule of the egress profile. */
	readonly hostPorts?: readonly { readonly host: string; readonly ports?: readonly number[] }[]
}

/**
 * Read the policy out of `NAMZU_EGRESS_PROXY_CONFIG`, or refuse it.
 *
 * Refusing means writing to stderr and calling `process.exit(1)` where this
 * file is the container's process — which is what a container's entrypoint can
 * do and what a test process cannot survive. Imported, which is how a test
 * reaches this function, it throws the same message as an `Error` instead: the
 * caller that imports it for an assertion would otherwise take the vitest
 * worker down with it, which reads as a crashed suite rather than a failing
 * assertion (observed here before the guard existed). Nothing about the
 * container changed — it runs the file as its `CMD`, so every refusal there
 * still exits non-zero, and `egress-proxy/__tests__/server.test.js` asserts the
 * exit code as a subprocess.
 *
 * `hardening.test.ts` imports it for both halves: the backend's own
 * serialisation is fed to it and must be accepted, and the shapes the backend
 * cannot produce, and the messages they may say, are asserted on it directly.
 * The day the two ends disagree, one of those fails.
 */
export declare function parseProxyConfig(
	raw: string | undefined,
	envName?: string,
): ParsedEgressProxyConfig

/**
 * Read a V2 policy (`NAMZU_EGRESS_PROXY_CONFIG_V2`): a V1 policy plus
 * `hostPorts`. Refuses a field it does not know rather than ignoring it.
 */
export declare function parseProxyConfigV2(raw: string | undefined): ParsedEgressProxyConfig

/** V2 when the environment carries it, otherwise V1; never both. */
export declare function readProxyConfig(
	env: Readonly<Record<string, string | undefined>>,
): ParsedEgressProxyConfig

/** The running proxy `startEgressProxy` returns: only what a caller may drive. */
export interface StartedEgressProxy {
	readonly port: number
	close(): Promise<void>
}

/**
 * Start the boundary from a parsed configuration. `loadProxy` replaces the
 * compiled boundary module, which only a test does; with port rules, the
 * module must export `egressPortsForRules` or the start is refused.
 */
export declare function startEgressProxy(
	config: ParsedEgressProxyConfig,
	loadProxy?: () => Promise<Record<string, unknown>>,
): Promise<StartedEgressProxy>
