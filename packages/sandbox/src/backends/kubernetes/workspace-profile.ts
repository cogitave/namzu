import { createHash } from 'node:crypto'
import type { KubernetesBackendInternalConfig } from './index.js'
import {
	type SandboxPodTemplate,
	type SandboxResourceSpec,
	type SandboxVolumeClaimTemplate,
	podTemplateHash,
} from './objects.js'

/** Original copied execution content. Current template names cannot reconstruct
 * this evidence after a rollout. Credentials and policy resource versions are
 * deliberately absent; admission re-verifies the current network boundary. */
export interface KubernetesWorkspaceExecutionProfile {
	readonly version: 1
	readonly cluster: string
	readonly namespace: string
	readonly templateName: string
	readonly agentPort: number
	readonly agentAddress: 'service' | 'pod-ip'
	readonly runtimeClassName: string
	readonly podTemplateHash: string
	readonly volumeClaimTemplatesHash: string
	readonly network: 'core/no-network'
	readonly networkVerificationEngine: 'core' | 'cilium'
	readonly networkPolicyName: string
	readonly fingerprint: string
}

export class KubernetesWorkspaceProfileConflictError extends Error {
	override readonly name = 'KubernetesWorkspaceProfileConflictError'
	constructor() {
		super('kubernetes: original workspace execution profile is missing, invalid or different')
	}
}

export function captureWorkspaceProfileConfig(
	config: KubernetesBackendInternalConfig,
): KubernetesBackendInternalConfig {
	return {
		...config,
		access: { ...config.access },
		...(config.egress ? { egress: structuredClone(config.egress) } : {}),
		...(config.ingress && typeof config.ingress === 'object'
			? { ingress: { ...config.ingress } }
			: {}),
	}
}

function refuse(): never {
	throw new KubernetesWorkspaceProfileConflictError()
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value === null || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
	)
}
function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}
const bounded = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= 253 && !value.includes('\0')
const contentHash = (value: unknown): value is string =>
	typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

/** Own and validate every historical field, including the descriptor hash. */
export function captureWorkspaceExecutionProfile(
	input: KubernetesWorkspaceExecutionProfile,
): KubernetesWorkspaceExecutionProfile {
	let value: KubernetesWorkspaceExecutionProfile
	try {
		value = JSON.parse(JSON.stringify(input)) as KubernetesWorkspaceExecutionProfile
	} catch {
		return refuse()
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) refuse()
	const { fingerprint, ...body } = value
	if (
		Object.keys(value).sort().join(',') !==
			[
				'version',
				'cluster',
				'namespace',
				'templateName',
				'agentPort',
				'agentAddress',
				'runtimeClassName',
				'podTemplateHash',
				'volumeClaimTemplatesHash',
				'network',
				'networkVerificationEngine',
				'networkPolicyName',
				'fingerprint',
			]
				.sort()
				.join(',') ||
		value.version !== 1 ||
		!bounded(value.namespace) ||
		!bounded(value.templateName) ||
		!bounded(value.runtimeClassName) ||
		!bounded(value.networkPolicyName) ||
		!Number.isSafeInteger(value.agentPort) ||
		value.agentPort < 1 ||
		value.agentPort > 65535 ||
		!['service', 'pod-ip'].includes(value.agentAddress) ||
		value.network !== 'core/no-network' ||
		!['core', 'cilium'].includes(value.networkVerificationEngine) ||
		!contentHash(value.podTemplateHash) ||
		!contentHash(value.volumeClaimTemplatesHash) ||
		!/^[a-f0-9]{64}$/.test(fingerprint) ||
		digest(body) !== fingerprint
	)
		refuse()
	let cluster: URL
	try {
		cluster = new URL(value.cluster)
	} catch {
		return refuse()
	}
	if (
		!['https:', 'http:'].includes(cluster.protocol) ||
		cluster.username ||
		cluster.password ||
		cluster.search ||
		cluster.hash ||
		cluster.pathname !== '/'
	)
		refuse()
	// HTTP is only meaningful for an explicit loopback test API.
	if (
		cluster.protocol === 'http:' &&
		!['localhost', '127.0.0.1', '[::1]'].includes(cluster.hostname)
	)
		refuse()
	if (cluster.origin !== value.cluster) refuse()
	return Object.freeze(value)
}

/** Content hashes retain copied labels/annotations and all execution-bearing
 * fields. Source-template resourceVersion/UID are not copied into this body. */
export function workspaceVolumeClaimTemplatesHash(
	claims: readonly SandboxVolumeClaimTemplate[] | undefined,
): string {
	if (!Array.isArray(claims) || claims.length === 0) refuse()
	return `sha256:${digest(claims)}`
}

function assertPinnedExecution(pod: SandboxPodTemplate, runtimeClassName: string): void {
	if (pod.spec.runtimeClassName !== runtimeClassName) refuse()
	const containers = pod.spec.containers
	if (!Array.isArray(containers) || containers.length === 0) refuse()
	const init = pod.spec.initContainers
	if (init !== undefined && !Array.isArray(init)) refuse()
	for (const item of [...containers, ...(init ?? [])]) {
		if (
			item === null ||
			typeof item !== 'object' ||
			typeof item.image !== 'string' ||
			!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(item.image)
		)
			refuse()
		if (item.envFrom !== undefined && (!Array.isArray(item.envFrom) || item.envFrom.length > 0))
			refuse()
		if (item.env !== undefined && !Array.isArray(item.env)) refuse()
		for (const env of item.env ?? []) {
			if (
				env?.valueFrom &&
				Object.keys(env.valueFrom).some((key) => key !== 'fieldRef' && key !== 'resourceFieldRef')
			)
				refuse()
		}
	}
	// These references can change execution content without changing PodSpec.
	const volumes = pod.spec.volumes
	if (volumes !== undefined && !Array.isArray(volumes)) refuse()
	for (const volume of volumes ?? []) {
		if (
			!volume ||
			typeof volume !== 'object' ||
			Object.keys(volume).some((key) => !['name', 'emptyDir', 'downwardAPI'].includes(key)) ||
			Object.keys(volume).filter((key) => key !== 'name').length !== 1
		)
			refuse()
	}
}

/** Native qualification has one supported boundary. Reject bypasses before
 * making any provider request; a named policy alone cannot close the union. */
export function assertWorkspaceProfileConfig(
	config: KubernetesBackendInternalConfig,
): asserts config is KubernetesBackendInternalConfig & {
	access: Exclude<KubernetesBackendInternalConfig['access'], { readonly inCluster: true }>
	runtimeClassName: string
	egress: NonNullable<KubernetesBackendInternalConfig['egress']> & {
		engine: 'core' | 'cilium'
		networkPolicyName: string
	}
} {
	if (
		config.access.inCluster === true ||
		config.ingress === 'unverified' ||
		(config.ingress?.engine ?? 'core') !== config.egress?.engine ||
		!bounded(config.runtimeClassName) ||
		!config.egress ||
		!['core', 'cilium'].includes(config.egress.engine ?? '') ||
		config.egress.policy.kind !== 'no-network' ||
		config.egress.verify === 'named-object-only' ||
		config.egress.profile !== undefined ||
		config.egress.profileLabelKey !== undefined ||
		!bounded(config.egress.networkPolicyName)
	)
		refuse()
}

export function describeWorkspaceExecutionProfile(input: {
	readonly config: KubernetesBackendInternalConfig
	readonly podTemplate: SandboxPodTemplate
	readonly volumeClaimTemplates: readonly SandboxVolumeClaimTemplate[] | undefined
}): KubernetesWorkspaceExecutionProfile {
	const { config, podTemplate, volumeClaimTemplates } = input
	assertWorkspaceProfileConfig(config)
	assertPinnedExecution(podTemplate, config.runtimeClassName)
	if (
		!volumeClaimTemplates?.length ||
		volumeClaimTemplates.some(
			(claim) =>
				!bounded(claim.spec?.storageClassName) ||
				claim.spec?.dataSource !== undefined ||
				claim.spec?.dataSourceRef !== undefined ||
				claim.spec?.volumeName !== undefined ||
				claim.spec?.selector !== undefined,
		)
	)
		refuse()
	const body = {
		version: 1 as const,
		cluster: new URL(config.access.server).origin,
		namespace: config.namespace,
		templateName: config.sandboxTemplateName,
		agentPort: config.agentPort ?? 1024,
		agentAddress: config.agentAddress ?? 'service',
		runtimeClassName: config.runtimeClassName,
		podTemplateHash: podTemplateHash(podTemplate),
		volumeClaimTemplatesHash: workspaceVolumeClaimTemplatesHash(input.volumeClaimTemplates),
		network: 'core/no-network' as const,
		networkVerificationEngine: config.egress.engine,
		networkPolicyName: config.egress.networkPolicyName,
	}
	return captureWorkspaceExecutionProfile({
		...body,
		fingerprint: digest(body),
	})
}

/** Current credentials reach the original approved locator; historical port,
 * template/runtime and desired boundary come from durable original evidence. */
export function workspaceConfigForOriginalProfile(
	config: KubernetesBackendInternalConfig,
	input: KubernetesWorkspaceExecutionProfile,
): KubernetesBackendInternalConfig {
	const profile = captureWorkspaceExecutionProfile(input)
	if (
		config.access.inCluster === true ||
		new URL(config.access.server).origin !== profile.cluster ||
		config.namespace !== profile.namespace
	)
		refuse()
	return {
		...config,
		access: { ...config.access },
		sandboxTemplateName: profile.templateName,
		agentPort: profile.agentPort,
		agentAddress: profile.agentAddress,
		runtimeClassName: profile.runtimeClassName,
		egress: {
			engine: profile.networkVerificationEngine,
			policy: { kind: 'no-network' },
			networkPolicyName: profile.networkPolicyName,
		},
		ingress: { engine: profile.networkVerificationEngine },
	}
}

export function assertWorkspaceExecutionContent(
	input: KubernetesWorkspaceExecutionProfile,
	spec: Pick<SandboxResourceSpec, 'podTemplate' | 'volumeClaimTemplates'> | undefined,
): void {
	const profile = captureWorkspaceExecutionProfile(input)
	if (
		!spec ||
		!spec.podTemplate ||
		podTemplateHash(spec.podTemplate) !== profile.podTemplateHash ||
		workspaceVolumeClaimTemplatesHash(spec.volumeClaimTemplates) !==
			profile.volumeClaimTemplatesHash
	)
		refuse()
}
