/**
 * Small shared plumbing for the five acceptance scripts in `../`: CLI flag
 * parsing, resolving a `KubernetesClusterAccess` from either `--in-cluster`
 * or an explicit `{ server, ca, getToken }`, and one consistent pass/fail
 * line format. No business logic lives here — every acceptance check itself
 * stays in its own script, readable start to finish on its own.
 */

import { readFileSync } from 'node:fs'
import https from 'node:https'

/**
 * `--flag value`, `--flag=value` and bare `--flag` (boolean `true`), in any
 * order. Not a general-purpose parser — just enough for these five scripts'
 * own flags, which this file also documents by being the one place they are
 * all read.
 */
export function parseArgs(argv) {
	const flags = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--')) continue
		const eq = arg.indexOf('=')
		if (eq !== -1) {
			flags[arg.slice(2, eq)] = arg.slice(eq + 1)
			continue
		}
		const name = arg.slice(2)
		const next = argv[i + 1]
		if (next !== undefined && !next.startsWith('--')) {
			flags[name] = next
			i++
		} else {
			flags[name] = true
		}
	}
	return flags
}

/** `--foo`/`NAMZU_K8S_FOO`, in that order, or `undefined` if neither is set. */
function readOption(flags, flagName, envVar) {
	if (flags[flagName] !== undefined) return String(flags[flagName])
	if (envVar && process.env[envVar] !== undefined) return process.env[envVar]
	return undefined
}

/** Like {@link readOption}, but throws naming both spellings when absent. */
export function requireOption(flags, flagName, envVar) {
	const value = readOption(flags, flagName, envVar)
	if (value === undefined) {
		throw new Error(`missing --${flagName}${envVar ? ` (or ${envVar})` : ''}`)
	}
	return value
}

/**
 * Build a `KubernetesClusterAccess` from flags/env — the same two-arm shape
 * `KubernetesBackendConfig.access` takes (see
 * `../../src/backends/kubernetes/k8s-client.ts`):
 *
 *   - `--in-cluster` (or `NAMZU_K8S_IN_CLUSTER=1`): the projected
 *     ServiceAccount volume + `KUBERNETES_SERVICE_HOST`/`_PORT` — for
 *     running one of these scripts as a Job/Pod under `rbac.yaml`'s
 *     ServiceAccount.
 *   - explicit: `--server`, optional `--ca-file`, and a bearer token from
 *     `--token` or `--token-file` (re-read on every call when a file is
 *     given, so a long `contract-suite`/`acquire-p50` run survives the same
 *     token rotation the backend itself tolerates in-cluster) — for running
 *     a script from a laptop or CI runner against a remote cluster.
 */
export function resolveAccess(flags) {
	const inCluster =
		flags['in-cluster'] === true ||
		flags['in-cluster'] === 'true' ||
		process.env.NAMZU_K8S_IN_CLUSTER === '1'
	if (inCluster) return { inCluster: true }

	const server = requireOption(flags, 'server', 'NAMZU_K8S_SERVER')
	const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
	const caFile = readOption(flags, 'ca-file', 'NAMZU_K8S_CA_FILE')
	const ca = caFile ? readFileSync(caFile) : undefined
	const tokenFile = readOption(flags, 'token-file', 'NAMZU_K8S_TOKEN_FILE')
	const staticToken = readOption(flags, 'token', 'NAMZU_K8S_TOKEN')
	if (!tokenFile && !staticToken) {
		throw new Error(
			'explicit (non---in-cluster) access needs a credential: --token, --token-file, NAMZU_K8S_TOKEN or NAMZU_K8S_TOKEN_FILE',
		)
	}
	const getToken = tokenFile
		? async () => readFileSync(tokenFile, 'utf8').trim()
		: async () => staticToken
	return { server, namespace, ca, getToken }
}

const DEFAULT_SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

/**
 * A bare, read-only GET against one path the package's own public surface
 * has no accessor for — today, only `acquire-p50.mjs`'s `SandboxWarmPool`
 * readiness check. Deliberately NOT a general client: it mirrors the same
 * two-source auth `../../src/backends/kubernetes/k8s-client.ts` documents
 * (in-cluster ServiceAccount files, re-read every call since kubelet
 * rotates the projected token; or the explicit `{ server, ca, getToken }`
 * this script's `--server`/`--token`/`--ca-file` flags already build) so a
 * script run either in-cluster (under `rbac.yaml`'s ServiceAccount) or from
 * outside works the same way the backend itself does. Never adds anything
 * to `@namzu/sandbox`'s own dependency-free posture — this file ships only
 * under `k8s/`, outside the published `files` list.
 */
export async function getResource(access, path) {
	let baseUrl
	let ca
	let getToken
	if (access.inCluster) {
		const dir = DEFAULT_SERVICE_ACCOUNT_DIR
		const host = process.env.KUBERNETES_SERVICE_HOST
		const port = process.env.KUBERNETES_SERVICE_PORT
		if (!host || !port) {
			throw new Error('--in-cluster needs KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT')
		}
		baseUrl = `https://${host}:${port}`
		ca = readFileSync(`${dir}/ca.crt`)
		getToken = async () => readFileSync(`${dir}/token`, 'utf8').trim()
	} else {
		baseUrl = access.server.endsWith('/') ? access.server.slice(0, -1) : access.server
		ca = access.ca
		getToken = access.getToken
	}

	const token = await getToken()
	const url = `${baseUrl}${path}`
	const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }

	if (ca === undefined) {
		const res = await fetch(url, { headers })
		if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
		return await res.json()
	}

	return await new Promise((resolve, reject) => {
		const target = new URL(url)
		const req = https.request(
			{
				hostname: target.hostname,
				port: target.port || 443,
				path: `${target.pathname}${target.search}`,
				method: 'GET',
				headers,
				ca,
				rejectUnauthorized: true,
			},
			(res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf8')
					if ((res.statusCode ?? 0) >= 300) {
						reject(new Error(`GET ${path} -> ${res.statusCode}`))
						return
					}
					resolve(body.length > 0 ? JSON.parse(body) : undefined)
				})
			},
		)
		req.on('error', reject)
		req.end()
	})
}

/** One line, one shape, across all five scripts. */
export function report(name, passed, detail) {
	const line = `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`
	console.log(line)
	if (!passed) process.exitCode = 1
	return passed
}
