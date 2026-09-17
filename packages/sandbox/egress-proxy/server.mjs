/**
 * `@namzu/sandbox` container-tier egress proxy — the container's own entrypoint.
 *
 * The docker backend used to run the egress proxy in its own process, on the
 * host's loopback, and point the sandbox at it with
 * `--add-host namzu-egress:host-gateway` plus `HTTP_PROXY`. Nothing in that
 * arrangement made traffic go through the proxy: an environment variable is a
 * request, and the sandbox kept ordinary bridge networking with full outbound
 * reachability the whole time. Untrusted code that opens a socket directly — a
 * Go or Rust binary that does not read proxy env, `curl --noproxy '*'`, a raw
 * `net.Socket` — reached the network with the allowlist unconsulted (#398).
 *
 * This file is the other half of the fix. The proxy now runs as a container of
 * its own, dual-homed: attached to an `--internal` network that the sandbox is
 * also on, and to an ordinary bridge through which it reaches the internet.
 * The sandbox is attached to the internal network ONLY, so its one route off
 * the box is the proxy's address on that network — a route it cannot remove,
 * because `--cap-drop=ALL` took `NET_ADMIN` away (see `HARDENING_ARGS` in
 * `src/backends/docker/index.ts`, which records that dependency).
 *
 * The proxy environment variables stay, and they still point at this process.
 * What changed is what they are: on this topology they DIRECT traffic rather
 * than permit it. A tool that honours them goes straight through; one that
 * ignores them gets `Network unreachable`, which is the whole difference this
 * issue was filed over.
 *
 * WHY A CONFIG BLOB RATHER THAN ITS OWN CONTROL CHANNEL. Everything the proxy
 * decides with — the allowlist, the brokered credentials, the inward-screen
 * exemption — arrives in `NAMZU_EGRESS_PROXY_CONFIG`, as JSON, in the
 * environment the backend started this container with. The alternative is a
 * control endpoint the host pushes policy to, which needs a second reachable
 * address on a container whose whole point is that only the sandbox can reach
 * it; a channel the sandbox can also reach is a channel the sandbox can ask to
 * widen its own allowlist. The environment is set by the backend at `docker
 * run` time and is not writable from inside. What it costs is that the host's
 * `resolver` policy is resolved when the container starts rather than per
 * request, and that a brokered credential is readable by anything with access
 * to the daemon (it was previously readable only by the process that held it).
 * Both are stated in `docs/sdk/sandbox-egress.md` rather than left to be
 * discovered; neither puts a credential inside the sandbox, which is where the
 * threat model's line is.
 *
 * WHAT THIS FILE IS NOT. It is not a second implementation of the boundary.
 * The allowlist, the address screen and the credential broker are
 * `src/egress/proxy.ts` — the same module the in-process proxy has always been
 * — compiled to `dist/egress` and copied into the image. This file only reads
 * the configuration, hands it over, and makes a failure loud.
 *
 * NOT MEASURED HERE. Nothing in this repository starts this container: there is
 * no Docker daemon in the test environment (see `hardening.test.ts` and the
 * `sandbox-smoke.yml` workflow, which is where a real daemon exists). What is
 * pinned by tests is the argv the backend renders for it, the config blob it
 * renders, and this file's parsing of that blob — the parts a change can break
 * silently. What a daemon would add is that the container comes up.
 */

import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

/** Where the backend puts the policy it wants enforced. */
const CONFIG_ENV = 'NAMZU_EGRESS_PROXY_CONFIG'

/**
 * The compiled boundary module, as the image lays it out.
 *
 * `Dockerfile` copies `dist/egress` to `/opt/namzu-egress/egress` beside this
 * file, so the relative resolution below is the image layout and not a
 * coincidence. It is also why the image writes a `{"type":"module"}`
 * `package.json` next to it: these are ESM sources, and a `.js` file with no
 * package.json above it is CommonJS to Node, which fails at the `import` on
 * its first line.
 */
const DEFAULT_PROXY_MODULE = new URL('./egress/index.js', import.meta.url)

/** Port the proxy listens on when the config does not name one. */
const DEFAULT_PORT = 2025

/**
 * Anything wrong with the configuration is a hard stop.
 *
 * A proxy that starts with a policy it could not read is worse than one that
 * does not start at all: the sandbox's only route out would be a process that
 * is up and deciding nothing, and every request through it would look exactly
 * like the policy working. So an unreadable config exits non-zero, the
 * container leaves `--rm` further down, and the sandbox — which has no route
 * out of its own — fails closed.
 */
function fail(message) {
	process.stderr.write(`namzu-egress-proxy: ${message}\n`)
	process.exit(1)
}

function requireString(value, where) {
	if (typeof value !== 'string' || value.length === 0) {
		fail(`${where} must be a non-empty string`)
	}
	return value
}

function optionalStringArray(value, where) {
	if (value === undefined) return undefined
	if (!Array.isArray(value)) fail(`${where} must be an array of strings`)
	return value.map((entry, index) => requireString(entry, `${where}[${index}]`))
}

/**
 * Read the policy out of the environment, refusing every shape that would
 * leave the boundary deciding something nobody asked for.
 *
 * `allowedHosts` is required rather than defaulted, and the distinction
 * matters: `[]` is a perfectly meaningful policy (deny everything) and is not
 * what a MISSING field means. Defaulting an absent allowlist to `[]` would
 * turn a config this file misread into a sandbox that resolves nothing, and
 * defaulting it the other way is an open proxy. Neither is a guess this file
 * is entitled to make.
 */
export function parseProxyConfig(raw) {
	if (typeof raw !== 'string' || raw.length === 0) {
		fail(`${CONFIG_ENV} is not set; this container has no policy to enforce`)
	}
	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		fail(`${CONFIG_ENV} is not valid JSON: ${error instanceof Error ? error.message : error}`)
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		fail(`${CONFIG_ENV} must be a JSON object`)
	}
	if (!Array.isArray(parsed.allowedHosts)) {
		fail(`${CONFIG_ENV}.allowedHosts must be an array of hostnames (an empty array means deny-all)`)
	}

	const port = parsed.port ?? DEFAULT_PORT
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		fail(`${CONFIG_ENV}.port must be an integer between 1 and 65535; got ${JSON.stringify(port)}`)
	}

	const credentials = parsed.credentials ?? []
	if (!Array.isArray(credentials)) fail(`${CONFIG_ENV}.credentials must be an array`)
	for (const [index, credential] of credentials.entries()) {
		if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
			fail(`${CONFIG_ENV}.credentials[${index}] must be an object`)
		}
		requireString(credential.host, `${CONFIG_ENV}.credentials[${index}].host`)
		requireString(credential.header, `${CONFIG_ENV}.credentials[${index}].header`)
		requireString(credential.value, `${CONFIG_ENV}.credentials[${index}].value`)
	}

	if (parsed.upgradeToHttps !== undefined && typeof parsed.upgradeToHttps !== 'boolean') {
		fail(`${CONFIG_ENV}.upgradeToHttps must be a boolean`)
	}

	return {
		port,
		allowedHosts: parsed.allowedHosts.map((entry, index) =>
			requireString(entry, `${CONFIG_ENV}.allowedHosts[${index}]`),
		),
		credentials,
		allowInwardFor: optionalStringArray(parsed.allowInwardFor, `${CONFIG_ENV}.allowInwardFor`),
		upgradeToHttps: parsed.upgradeToHttps,
		selfNames: optionalStringArray(parsed.selfNames, `${CONFIG_ENV}.selfNames`),
	}
}

async function loadDefaultProxy() {
	return await import(DEFAULT_PROXY_MODULE.href)
}

/**
 * Start the boundary. Returns the running proxy so a caller can drive it.
 *
 * `loadProxy` is a parameter rather than an environment variable on purpose.
 * A seam that production reads from the environment is one more thing an
 * operator can point somewhere else by accident; a parameter is test-only
 * because nothing but a test passes one.
 */
export async function startEgressProxy(config, loadProxy = loadDefaultProxy) {
	const { EgressProxy } = await loadProxy()

	// The proxy's own container name and network alias are the names a client
	// on the internal network reaches it by, so they are the names the loop
	// guard has to know — see `EgressProxyOptions.selfNames`. The hostname is
	// read here rather than passed in because the backend already sets it
	// (`--hostname`, in `renderEgressProxyRunArgs`), and a value copied into
	// two places is a value that can disagree with itself.
	const selfNames = [...new Set([...(config.selfNames ?? []), hostname()])].filter(Boolean)

	const proxy = new EgressProxy({
		allowedHosts: async () => config.allowedHosts,
		...(config.credentials.length > 0 ? { credentials: config.credentials } : {}),
		...(config.allowInwardFor ? { allowInwardFor: config.allowInwardFor } : {}),
		...(config.upgradeToHttps !== undefined ? { upgradeToHttps: config.upgradeToHttps } : {}),
		...(selfNames.length > 0 ? { selfNames } : {}),
		// The container IS the boundary: the sandbox sits on an internal
		// network with nothing but this container on it. See
		// `EgressProxyOptions.bindHost`.
		bindHost: '0.0.0.0',
	})

	const running = await proxy.listen(config.port)
	// One line, no credential values, no allowlist contents: an operator
	// reading `docker logs` needs to know the boundary is up and on which
	// port, and a log is not a place to spill what it is holding.
	process.stdout.write(
		`namzu-egress-proxy: listening on 0.0.0.0:${running.port} with ${config.allowedHosts.length} allowed host(s) and ${config.credentials.length} brokered credential(s)\n`,
	)
	return running
}

async function main() {
	const config = parseProxyConfig(process.env[CONFIG_ENV])

	// Registered BEFORE the boundary is up, so a stop that arrives while this
	// process is still starting is handled rather than killing it by default
	// action. Nothing is listening yet at that point, so there is nothing to
	// close and exiting is the whole of the job.
	//
	// `let`, and the linter is right that it is assigned once: the assignment
	// cannot move up into the declaration, because the handler closed over it
	// has to exist before `startEgressProxy` is awaited.
	// biome-ignore lint/style/useConst: assigned once, deliberately after the handler that reads it is registered
	let running
	const stop = () => {
		if (!running) {
			process.exit(0)
		}
		running.close().then(
			() => process.exit(0),
			() => process.exit(1),
		)
	}
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)

	running = await startEgressProxy(config)
}

// Imported by a test, or run as the container's command — and the two must not
// be confused, because the second one exits the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		fail(`could not start: ${error instanceof Error ? error.stack : String(error)}`)
	})
}
