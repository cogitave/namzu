/**
 * Egress profiles: one named, validated host allowlist, with optional ports,
 * that a host can hand to more than one backend and have it mean the same
 * thing on each.
 *
 * The idea is the Gateway allowlist of google/ax (`HostRule { host, port }`),
 * re-implemented against this package's own types. What is deliberately NOT
 * taken from it: a `*:443` fallback when nothing is listed, continuing after a
 * failed apply, credentials in the profile, and a controller that watches for
 * changes. A profile with no hosts is no egress; there is no wildcard; a
 * backend that cannot honour a part of a profile refuses it at construction,
 * before any I/O, rather than applying the rest.
 *
 * A profile carries no credentials. Credential brokering exists only on the
 * docker egress proxy, and `ContainerBackendConfig.brokeredCredentials` stays
 * where it is on purpose; under a profile, a credential for a host the profile
 * does not allow is refused (see `assertBrokeredCredentialsFitProfile`).
 */

import type {
	KubernetesCiliumEgressNarrowing,
	KubernetesEgressConfig,
	KubernetesEgressEngine,
	KubernetesEgressVerification,
} from '../backends/kubernetes/egress-policy.js'
import type { EgressPolicy } from '../index.js'
import { isHostAllowed } from './allowlist.js'

/** One allowlist entry of a {@link SandboxEgressProfile}. */
export interface SandboxEgressHostRule {
	/**
	 * `api.example.com` for that host, `.example.com` for that domain and
	 * every subdomain of it: the grammar `isHostAllowed` implements and
	 * `SandboxNetworkPolicy.allowedHosts` states. No `*`, no scheme, no path,
	 * no port suffix, no IP address.
	 */
	readonly host: string
	/**
	 * TCP ports this rule allows, each 1-65535. Absent means every port.
	 *
	 * When several rules match one host (`api.example.com` and `.example.com`
	 * both match `api.example.com`), the host may use the UNION of their ports,
	 * and a matching rule with no `ports` makes every port allowed. That is
	 * what Cilium does with the rules that select a pod, and the docker egress
	 * proxy computes the same union, so a profile means one thing on both.
	 */
	readonly ports?: readonly number[]
}

/** A named egress allowlist. See the module doc. */
export interface SandboxEgressProfile {
	/** A DNS-1123 label: lowercase letters, digits and `-`, at most 63 characters. */
	readonly name: string
	/** The allowed hosts. An empty list means no egress at all. */
	readonly hosts: readonly SandboxEgressHostRule[]
}

/** Why a profile was refused. */
export type SandboxEgressProfileErrorCode =
	| 'invalid-name'
	| 'invalid-host'
	| 'invalid-port'
	| 'duplicate-host'
	| 'conflicting-policy'
	| 'unsupported'

/**
 * A profile that is malformed, or that a backend cannot honour in full.
 *
 * `path` names the offending field relative to the profile (`hosts[1].ports`)
 * or to the config it was combined with (`defaultEgress`); `backend` names the
 * backend that refused, when the refusal is about a backend rather than about
 * the profile itself.
 */
export class SandboxEgressProfileError extends Error {
	override readonly name = 'SandboxEgressProfileError'

	constructor(
		readonly code: SandboxEgressProfileErrorCode,
		readonly path: string,
		reason: string,
		readonly backend?: string,
	) {
		super(
			`egress profile: ${path} ${reason}${backend !== undefined ? ` (backend: ${backend})` : ''}. Refusing rather than applying part of the profile.`,
		)
	}
}

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

/** Lowercase, no surrounding whitespace, no trailing dot. */
function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '')
}

function hostProblem(host: string): string | undefined {
	if (host === '') return 'is empty'
	if (host.includes('*')) {
		return "contains a wildcard; a domain and its subdomains are written with a leading dot ('.example.com'), and there is no allow-everything entry"
	}
	const bare = host.startsWith('.') ? host.slice(1) : host
	if (bare === '') return 'names no domain after its leading dot'
	if (!DNS_NAME.test(bare)) {
		return 'is not a hostname (a scheme, a path, a port suffix and an IPv6 address all land here)'
	}
	if (bare.length > 253) return 'is longer than a DNS name may be'
	if (host.startsWith('.') && !bare.includes('.')) {
		return "names a whole top-level domain; a domain entry needs at least two labels, as in '.example.com'"
	}
	if (/^[0-9]+$/.test(bare.slice(bare.lastIndexOf('.') + 1))) {
		return 'ends in an all-numeric label, so it is an address rather than a hostname'
	}
	return undefined
}

/**
 * Validate and normalise a profile. The result is frozen, hosts are lowercased
 * without a trailing dot, and ports are sorted.
 *
 * Refused with {@link SandboxEgressProfileError}: a name that is not a
 * DNS-1123 label; a host outside the allowlist grammar (`*`, a scheme, a path,
 * `host:port`, an IP literal); a port that is not an integer from 1 to 65535,
 * a repeated port, or `ports: []` (write no `ports` for every port; an empty
 * list would read as none and as all at once); and a host listed twice.
 */
export function defineEgressProfile(input: SandboxEgressProfile): SandboxEgressProfile {
	if (typeof input?.name !== 'string' || !DNS_1123_LABEL.test(input.name)) {
		throw new SandboxEgressProfileError(
			'invalid-name',
			'name',
			`${JSON.stringify(input?.name)} is not a DNS-1123 label (lowercase letters, digits and dashes, starting and ending alphanumeric, at most 63 characters)`,
		)
	}
	if (!Array.isArray(input.hosts)) {
		throw new SandboxEgressProfileError('invalid-host', 'hosts', 'is not a list')
	}
	const seen = new Set<string>()
	const hosts = input.hosts.map((rule, index): SandboxEgressHostRule => {
		const path = `hosts[${index}]`
		if (typeof rule?.host !== 'string') {
			throw new SandboxEgressProfileError('invalid-host', `${path}.host`, 'is not a string')
		}
		const host = normalizeHost(rule.host)
		const problem = hostProblem(host)
		if (problem !== undefined) {
			throw new SandboxEgressProfileError(
				'invalid-host',
				`${path}.host`,
				`${JSON.stringify(rule.host)} ${problem}`,
			)
		}
		if (seen.has(host)) {
			throw new SandboxEgressProfileError(
				'duplicate-host',
				`${path}.host`,
				`${JSON.stringify(rule.host)} is listed more than once; merge the ports into one rule`,
			)
		}
		seen.add(host)
		if (rule.ports === undefined) return Object.freeze({ host })
		if (!Array.isArray(rule.ports) || rule.ports.length === 0) {
			throw new SandboxEgressProfileError(
				'invalid-port',
				`${path}.ports`,
				'is empty; leave ports out to allow every port, or list at least one',
			)
		}
		const ports = new Set<number>()
		;(rule.ports as readonly number[]).forEach((port: number, portIndex: number) => {
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new SandboxEgressProfileError(
					'invalid-port',
					`${path}.ports[${portIndex}]`,
					`${JSON.stringify(port)} is not a TCP port (an integer from 1 to 65535)`,
				)
			}
			if (ports.has(port)) {
				throw new SandboxEgressProfileError(
					'invalid-port',
					`${path}.ports[${portIndex}]`,
					`${port} is listed more than once`,
				)
			}
			ports.add(port)
		})
		return Object.freeze({ host, ports: Object.freeze([...ports].sort((a, b) => a - b)) })
	})
	return Object.freeze({ name: input.name, hosts: Object.freeze(hosts) })
}

/**
 * The ports `host` may use under `profile`, or `'any'`.
 *
 * The union over every rule that matches the host; a matching rule with no
 * `ports` makes it `'any'`. No matching rule is the empty list.
 */
export function egressProfilePortsFor(
	profile: SandboxEgressProfile,
	host: string,
): readonly number[] | 'any' {
	return portsForRules(profile.hosts, host)
}

function portsForRules(
	rules: readonly SandboxEgressHostRule[],
	host: string,
): readonly number[] | 'any' {
	const ports = new Set<number>()
	for (const rule of rules) {
		if (!isHostAllowed(host, [rule.host])) continue
		if (rule.ports === undefined) return 'any'
		for (const port of rule.ports) ports.add(port)
	}
	return [...ports].sort((a, b) => a - b)
}

/**
 * Whether `profile` lets `host` be reached on `port`: some matching rule
 * either lists the port or lists no ports at all. This is the single
 * implementation of the union rule; the docker proxy and the tests share it.
 */
export function egressProfileAllowsPort(
	profile: SandboxEgressProfile,
	host: string,
	port: number,
): boolean {
	const ports = egressProfilePortsFor(profile, host)
	return ports === 'any' || ports.includes(port)
}

/**
 * An `EgressProxyOptions.allowedPorts` function for a list of profile rules,
 * with the same union rule as {@link egressProfileAllowsPort}. This is how the
 * egress proxy container turns the rules it is handed into a port check, so
 * the proxy and the profile cannot disagree about what a rule means.
 */
export function egressPortsForRules(
	rules: readonly SandboxEgressHostRule[],
): (host: string) => readonly number[] | 'any' {
	return (host) => portsForRules(rules, host)
}

/** Whether any rule of the profile carries `ports`. */
export function egressProfileHasPorts(profile: SandboxEgressProfile): boolean {
	return profile.hosts.some((rule) => rule.ports !== undefined)
}

/**
 * Whether an allowlist ENTRY (not a host) stays inside the profile.
 *
 * A plain host must be matched by a rule. A `.domain` entry covers a domain
 * and all of its subdomains, so it needs a `.domain` rule for that domain or a
 * parent of it: `api.example.com` in the profile does not cover
 * `.api.example.com`, whose subdomains it never listed.
 */
export function egressProfileCoversEntry(profile: SandboxEgressProfile, entry: string): boolean {
	const normalized = normalizeHost(entry)
	if (!normalized.startsWith('.'))
		return isHostAllowed(
			normalized,
			profile.hosts.map((r) => r.host),
		)
	const domain = normalized.slice(1)
	return profile.hosts.some(
		(rule) =>
			rule.host.startsWith('.') && (domain === rule.host.slice(1) || domain.endsWith(rule.host)),
	)
}

/**
 * The shared {@link EgressPolicy} a profile becomes on a backend that takes
 * one per create: `deny-all` for no hosts, otherwise a `static` allowlist of
 * the hosts as normalised. Ports are not in `EgressPolicy`; a backend that
 * enforces them reads them from the profile.
 */
export function egressPolicyFromProfile(profile: SandboxEgressProfile): EgressPolicy {
	if (profile.hosts.length === 0) return { kind: 'deny-all' }
	return { kind: 'static', allowedHosts: profile.hosts.map((rule) => rule.host) }
}

/** How {@link kubernetesEgressFromProfile} should have the profile enforced. */
export interface KubernetesEgressProfileEnforcement {
	/** Required to be `'cilium'` when any rule carries `ports`, and for any host at all. */
	readonly engine?: KubernetesEgressEngine
	readonly verify?: KubernetesEgressVerification
	readonly networkPolicyName?: string
	/**
	 * Write the profile's name as the pod's egress-profile label. Default
	 * `false`, and the default output is then exactly what a hand-written
	 * config with the same policy would be.
	 *
	 * Turning it on changes things an operator has to act on: the default
	 * policy object becomes `${template}-${profile}-egress`, a stock controller
	 * refuses the claim until `allowed-label-domains` admits the key, and an
	 * existing workspace without the label no longer adopts. See
	 * `KubernetesEgressConfig.profile`.
	 */
	readonly profileLabel?: boolean
	/** Only with `profileLabel: true`. See `KubernetesEgressConfig.profileLabelKey`. */
	readonly profileLabelKey?: string
	/** Only with at least one host. See `KubernetesCiliumEgressNarrowing.dnsNames`. */
	readonly dnsNames?: KubernetesCiliumEgressNarrowing['dnsNames']
}

/**
 * Translate a profile into the existing {@link KubernetesEgressConfig}, for
 * `KubernetesBackendConfig.egress`.
 *
 * Pure, and the one path for kubernetes: `createSandboxProvider` refuses
 * `egressProfile` on a kubernetes backend and points here instead, because
 * `createKubernetesWorkspace` takes the backend config directly and a
 * provider-level profile would never reach a workspace. Put the result in
 * `backend.egress` and task sandboxes and workspaces are enforced alike.
 *
 * No hosts is `deny-all`; otherwise a `static` allowlist. Ports become
 * `ciliumNarrowing.hostPorts`, keyed by the host as written, and need
 * `engine: 'cilium'`. A core engine with hosts is refused later, at wiring, by
 * the backend's own `KubernetesUnenforceableEgressPolicyError`.
 */
export function kubernetesEgressFromProfile(
	profile: SandboxEgressProfile,
	enforcement: KubernetesEgressProfileEnforcement = {},
): KubernetesEgressConfig {
	const defined = defineEgressProfile(profile)
	const hostPorts: Record<string, readonly number[]> = {}
	defined.hosts.forEach((rule, index) => {
		if (rule.ports === undefined) return
		if (enforcement.engine !== 'cilium') {
			throw new SandboxEgressProfileError(
				'unsupported',
				`hosts[${index}].ports`,
				"needs engine: 'cilium'; core NetworkPolicy cannot restrict a hostname's ports",
				'kubernetes',
			)
		}
		hostPorts[rule.host] = rule.ports
	})
	if (defined.hosts.length === 0 && enforcement.dnsNames !== undefined) {
		throw new SandboxEgressProfileError(
			'unsupported',
			'enforcement.dnsNames',
			'narrows the DNS rule of a hostname allowlist, and a profile with no hosts is deny-all',
			'kubernetes',
		)
	}
	if (enforcement.profileLabel !== true && enforcement.profileLabelKey !== undefined) {
		throw new SandboxEgressProfileError(
			'conflicting-policy',
			'enforcement.profileLabelKey',
			'is set without profileLabel: true, so no label would be written under it',
			'kubernetes',
		)
	}
	const narrowing: KubernetesCiliumEgressNarrowing = {
		...(Object.keys(hostPorts).length > 0 ? { hostPorts } : {}),
		...(enforcement.dnsNames !== undefined ? { dnsNames: enforcement.dnsNames } : {}),
	}
	return {
		policy:
			defined.hosts.length === 0
				? { kind: 'deny-all' }
				: { kind: 'static', allowedHosts: defined.hosts.map((rule) => rule.host) },
		...(enforcement.networkPolicyName !== undefined
			? { networkPolicyName: enforcement.networkPolicyName }
			: {}),
		...(enforcement.engine !== undefined ? { engine: enforcement.engine } : {}),
		...(enforcement.verify !== undefined ? { verify: enforcement.verify } : {}),
		...(Object.keys(narrowing).length > 0 ? { ciliumNarrowing: narrowing } : {}),
		...(enforcement.profileLabel === true
			? {
					profile: defined.name,
					...(enforcement.profileLabelKey !== undefined
						? { profileLabelKey: enforcement.profileLabelKey }
						: {}),
				}
			: {}),
	}
}
