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
 * The sandbox is attached to the internal network ONLY, which has no route off
 * it — its traffic reaches the internet through this container's address on
 * that network, and through nothing else. A route it cannot put back, because
 * `--cap-drop=ALL` took `NET_ADMIN` away (see `HARDENING_ARGS` in
 * `src/backends/docker/index.ts`, which records that dependency). What it can
 * reach is not only this container: the internal network is a subnet, so
 * anything else a host attaches to it — a second sandbox, that sandbox's proxy
 * — is reachable too, which `docs/sdk/sandbox-egress.md` states in full.
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
 * The second version of the same policy, which adds port rules.
 *
 * A separate variable rather than a new field in the first, so that an image
 * built before port rules existed cannot read a policy with ports and enforce
 * it without them: such an image reads only `CONFIG_ENV`, finds it unset when
 * the backend sends this one alone, and exits, which fails closed. The backend
 * sends this variable only when a profile carries ports, and checks the image's
 * `ai.namzu.egress-proxy.config` label first so the usual case is a named
 * refusal rather than a proxy that never came up.
 */
const CONFIG_ENV_V2 = 'NAMZU_EGRESS_PROXY_CONFIG_V2'

/** Every field a V2 config may carry. Anything else is refused, not ignored. */
const V2_FIELDS = new Set([
	'port',
	'allowedHosts',
	'credentials',
	'allowInwardFor',
	'upgradeToHttps',
	'selfNames',
	'hostPorts',
])

/**
 * Whether this file is the process's command, or was imported by one.
 *
 * The container's `CMD` is `node /opt/namzu-egress/server.mjs`, so every
 * refusal in the container still ends in `process.exit(1)`. A test that
 * imports the parser is the other case, and what it must not do is kill the
 * runner — see {@link fail}. The expression is the same one that decides
 * whether `main()` runs, evaluated once here rather than in two places that
 * could disagree.
 */
const IS_ENTRYPOINT =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

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
 * does not start at all: the only way the sandbox's traffic reaches the
 * internet would be a process that is up and deciding nothing, and every
 * request through it would look exactly like the policy working. So an
 * unreadable config exits non-zero, the container leaves `--rm` further down,
 * and the sandbox — which reaches the internet through nothing else — fails
 * closed.
 *
 * Refusing EXITS only where this file is the container's process. Imported, it
 * throws: `process.exit(1)` inside a test runner takes the whole worker down,
 * which reads as a crashed suite rather than a failing assertion, and the
 * parser is worth asserting on directly — `hardening.test.ts` does, on the
 * shapes the backend produces and on the shapes it must not. The container is
 * unaffected: it runs this file as its command, and {@link IS_ENTRYPOINT} is
 * read from the process rather than passed in as a seam a deployment could get
 * wrong.
 */
function fail(message) {
	if (!IS_ENTRYPOINT) throw new Error(`namzu-egress-proxy: ${message}`)
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
export function parseProxyConfig(raw, envName = CONFIG_ENV) {
	const parsed = parseConfigObject(raw, envName)
	if (!Array.isArray(parsed.allowedHosts)) {
		fail(`${envName}.allowedHosts must be an array of hostnames (an empty array means deny-all)`)
	}

	const port = parsed.port ?? DEFAULT_PORT
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		fail(`${envName}.port must be an integer between 1 and 65535; got ${JSON.stringify(port)}`)
	}

	const credentials = parsed.credentials ?? []
	if (!Array.isArray(credentials)) fail(`${envName}.credentials must be an array`)
	for (const [index, credential] of credentials.entries()) {
		if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
			fail(`${envName}.credentials[${index}] must be an object`)
		}
		requireString(credential.host, `${envName}.credentials[${index}].host`)
		requireString(credential.header, `${envName}.credentials[${index}].header`)
		requireString(credential.value, `${envName}.credentials[${index}].value`)
	}

	if (parsed.upgradeToHttps !== undefined && typeof parsed.upgradeToHttps !== 'boolean') {
		fail(`${envName}.upgradeToHttps must be a boolean`)
	}

	return {
		port,
		allowedHosts: parsed.allowedHosts.map((entry, index) =>
			requireString(entry, `${envName}.allowedHosts[${index}]`),
		),
		credentials,
		allowInwardFor: optionalStringArray(parsed.allowInwardFor, `${envName}.allowInwardFor`),
		upgradeToHttps: parsed.upgradeToHttps,
		selfNames: optionalStringArray(parsed.selfNames, `${envName}.selfNames`),
	}
}

/**
 * Read a V2 policy: everything a V1 policy carries, plus `hostPorts`, the
 * egress profile's rules as `[{ host, ports? }]`. Every rule of the profile is
 * listed, with or without ports, because the port a host may use is the union
 * over every rule that matches it and a rule left out would change that union.
 *
 * Stricter than V1 on purpose: a field this file does not know is refused
 * rather than ignored, because a V2 config comes from a backend newer than
 * this parser may be, and an ignored field there is a rule not enforced.
 */
export function parseProxyConfigV2(raw) {
	const base = parseProxyConfig(raw, CONFIG_ENV_V2)
	const parsed = parseConfigObject(raw, CONFIG_ENV_V2)
	for (const key of Object.keys(parsed)) {
		if (!V2_FIELDS.has(key)) {
			fail(
				`${CONFIG_ENV_V2}.${key} is not a field this proxy reads; refusing rather than ignoring it`,
			)
		}
	}
	if (!Array.isArray(parsed.hostPorts)) {
		fail(`${CONFIG_ENV_V2}.hostPorts must be an array of { host, ports? } rules`)
	}
	const hostPorts = parsed.hostPorts.map((rule, index) => {
		const where = `${CONFIG_ENV_V2}.hostPorts[${index}]`
		if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
			fail(`${where} must be an object`)
		}
		for (const key of Object.keys(rule)) {
			if (key !== 'host' && key !== 'ports') fail(`${where}.${key} is not a field this proxy reads`)
		}
		const host = requireString(rule.host, `${where}.host`)
		if (rule.ports === undefined) return { host }
		if (!Array.isArray(rule.ports) || rule.ports.length === 0) {
			fail(`${where}.ports must be a non-empty array of ports, or absent for every port`)
		}
		const seen = new Set()
		for (const [portIndex, port] of rule.ports.entries()) {
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				fail(
					`${where}.ports[${portIndex}] must be an integer between 1 and 65535; got ${JSON.stringify(port)}`,
				)
			}
			if (seen.has(port)) fail(`${where}.ports[${portIndex}] repeats port ${port}`)
			seen.add(port)
		}
		return { host, ports: [...rule.ports] }
	})
	return { ...base, hostPorts }
}

/**
 * The policy this container was started with: V2 when the backend sent it,
 * otherwise V1. Never both, and never a merge of the two.
 */
export function readProxyConfig(env) {
	if (env[CONFIG_ENV_V2] !== undefined) return parseProxyConfigV2(env[CONFIG_ENV_V2])
	return parseProxyConfig(env[CONFIG_ENV])
}

function parseConfigObject(raw, envName) {
	if (typeof raw !== 'string' || raw.length === 0) {
		fail(`${envName} is not set; this container has no policy to enforce`)
	}
	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		// Where the parse stopped is a fact about the configuration that a
		// deployer needs and that cannot be a credential. The rest of V8's
		// message cannot be trusted that way: `JSON.parse` embeds a snippet of
		// the INPUT in it, and the input here is the whole policy, brokered
		// credential values included — on its way to this container's stderr,
		// which is what `docker logs` shows and what a deployment may ship to a
		// collector. So the position is kept and the snippet is dropped.
		const at =
			error instanceof Error
				? error.message.match(/at position \d+ \(line \d+ column \d+\)/)?.[0]
				: undefined
		fail(`${envName} is not valid JSON${at === undefined ? '' : ` (${at})`}`)
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		fail(`${envName} must be a JSON object`)
	}
	return parsed
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
	const loaded = await loadProxy()
	const { EgressProxy } = loaded
	// Port rules are enforced by the boundary module's own implementation of
	// the profile's union rule, never by a second copy of it in this file.
	let allowedPorts
	if (config.hostPorts !== undefined) {
		if (typeof loaded.egressPortsForRules !== 'function') {
			fail(
				'the boundary module in this image has no egressPortsForRules, so it cannot enforce port rules; rebuild the image',
			)
		}
		allowedPorts = loaded.egressPortsForRules(config.hostPorts)
	}

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
		...(allowedPorts !== undefined ? { allowedPorts } : {}),
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
		`namzu-egress-proxy: listening on 0.0.0.0:${running.port} with ${config.allowedHosts.length} allowed host(s)${config.hostPorts !== undefined ? `, ${config.hostPorts.length} port rule(s)` : ''} and ${config.credentials.length} brokered credential(s)\n`,
	)
	return running
}

async function main() {
	const config = readProxyConfig(process.env)

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
// be confused, because the second one exits the process. See
// {@link IS_ENTRYPOINT}.
if (IS_ENTRYPOINT) {
	main().catch((error) => {
		fail(`could not start: ${error instanceof Error ? error.stack : String(error)}`)
	})
}
