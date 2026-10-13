import { OperationDeadline } from '../readiness.js'
import { egressProfileLabel } from './egress-policy.js'
import type { KubernetesWorkspaceIdentity } from './identity.js'
import {
	DEFAULT_AGENT_PORT,
	type KubernetesBackendInternalConfig,
	bindingFromSandbox,
	clientAccess,
	clientOptions,
	resolveAgentAddress,
	resolveKubernetesReadiness,
} from './index.js'
import { createKubernetesClient } from './k8s-client.js'
import {
	type KubernetesObjectMeta,
	type PodResource,
	type SandboxResource,
	buildHolderEpochPatch,
	isPodLive,
	isPodStopped,
	persistentVolumeClaimPath,
	podCollectionPath,
	readHolderEpoch,
	readPodIP,
	sandboxPath,
} from './objects.js'
import { KubernetesAgentTransport } from './transport.js'
import {
	type KubernetesWorkspaceAllocation,
	assertWorkspaceAllocationResource,
	captureWorkspaceAllocation,
} from './workspace-allocation.js'
import { KubernetesWorkspaceClosureConflictError } from './workspace-closure.js'
import { workspaceConfigForOriginalProfile } from './workspace-profile.js'
import {
	type KubernetesWorkspace,
	assertAdoptedWorkspaceMatchesConfig,
	openKubernetesWorkspaceForClosure,
	verifyOriginalWorkspaceAdmission,
	workspaceSandboxName,
} from './workspace.js'

/** Real disk identity, including when no pod or guest currently exists. */
export interface KubernetesWorkspaceVolumeIdentity {
	readonly sandboxUid: string
	readonly volumeClaimUids: Readonly<Record<string, string>>
}

export interface KubernetesWorkspaceVolumeObservation {
	readonly identity: KubernetesWorkspaceVolumeIdentity
	readonly epoch: number
	readonly mode: 'Running' | 'Suspended'
}

export interface KubernetesWorkspaceVolumeInspectOptions {
	/** The original allocation marker, persisted before dispatch. */
	readonly expectedAllocation?: KubernetesWorkspaceAllocation
	/** Require the retained disk to match the configured execution profile. */
	readonly requireConfiguredProfile?: boolean
	readonly epoch: number
	readonly signal?: AbortSignal
}

export interface KubernetesWorkspaceVolumeOpenOptions {
	/** Require the original allocation marker before any wake or guest contact. */
	readonly expectedAllocation?: KubernetesWorkspaceAllocation
	/** Validate the execution profile in the same owner read that fences wake. */
	readonly requireConfiguredProfile?: boolean
	readonly workspaceId: string
	readonly workingDirectory: string
	readonly identity: KubernetesWorkspaceVolumeIdentity
	readonly previousEpoch: number
	/** Unchanged for an already-running owner; previousEpoch + 1 for a wake. */
	readonly epoch: number
	readonly signal?: AbortSignal
}

type OwnedMeta = KubernetesObjectMeta & {
	readonly ownerReferences?: readonly {
		readonly uid?: string
		readonly controller?: boolean
	}[]
}
type OwnedPod = PodResource & { readonly metadata?: OwnedMeta }

function checkedEpoch(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
		throw new Error('kubernetes: volume closure requires an explicit valid epoch')
	return value
}

function capturedIdentity(
	input: KubernetesWorkspaceVolumeIdentity,
): KubernetesWorkspaceVolumeIdentity {
	if (
		!input ||
		typeof input.sandboxUid !== 'string' ||
		input.sandboxUid.length === 0 ||
		!input.volumeClaimUids ||
		typeof input.volumeClaimUids !== 'object' ||
		Array.isArray(input.volumeClaimUids)
	)
		throw new Error('kubernetes: volume closure requires a complete disk identity')
	const entries = Object.entries(input.volumeClaimUids).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)
	if (
		entries.length === 0 ||
		entries.length > 100 ||
		entries.some(([name, uid]) => !name || typeof uid !== 'string' || !uid)
	)
		throw new Error('kubernetes: volume closure requires a complete disk identity')
	return Object.freeze({
		sandboxUid: input.sandboxUid,
		volumeClaimUids: Object.freeze(Object.fromEntries(entries)),
	})
}

function volumeRuntime(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	requireConfiguredProfile = false,
	expectedAllocation?: KubernetesWorkspaceAllocation,
) {
	const namespace = config.namespace
	const name = workspaceSandboxName(workspaceId)
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const requiredProfile = requireConfiguredProfile
		? {
				sandboxTemplateName: config.sandboxTemplateName,
				profile: egressProfileLabel(config.egress),
				runtimeClassName: config.runtimeClassName,
			}
		: undefined
	function fail(): never {
		throw new KubernetesWorkspaceClosureConflictError(workspaceId)
	}
	const read = async <T>(path: string, signal: AbortSignal): Promise<T> => {
		const value = await client.request<T>('GET', path, undefined, signal)
		return value === undefined ? fail() : value
	}
	async function owner(signal: AbortSignal, expected?: KubernetesWorkspaceVolumeIdentity) {
		const first = await read<SandboxResource>(sandboxPath(namespace, name), signal)
		if (expectedAllocation)
			assertWorkspaceAllocationResource(workspaceId, expectedAllocation, first)
		if (requiredProfile)
			assertAdoptedWorkspaceMatchesConfig(name, namespace, first.spec?.podTemplate, requiredProfile)
		const uid = first.metadata?.uid
		const version = first.metadata?.resourceVersion
		const mode = first.spec?.operatingMode
		const epoch = readHolderEpoch(first.metadata).epoch
		if (
			typeof uid !== 'string' ||
			!uid ||
			typeof version !== 'string' ||
			!version ||
			first.metadata?.deletionTimestamp != null ||
			(mode !== 'Running' && mode !== 'Suspended') ||
			epoch === undefined ||
			(expected && uid !== expected.sandboxUid)
		)
			fail()
		checkedEpoch(epoch)
		const names = first.spec?.volumeClaimTemplates?.map((claim) => claim.metadata?.name)
		if (
			!names ||
			names.length === 0 ||
			names.length > 100 ||
			names.some((entry) => typeof entry !== 'string' || !entry) ||
			new Set(names).size !== names.length
		)
			fail()
		const claimNames = names
			.map((entry) => {
				if (typeof entry !== 'string' || !entry) return fail()
				return entry
			})
			.sort()
		if (
			expected &&
			JSON.stringify(claimNames) !== JSON.stringify(Object.keys(expected.volumeClaimUids))
		)
			fail()
		const claims: Record<string, string> = {}
		const versions: Record<string, string> = {}
		async function readClaims(repeated: boolean) {
			for (const claimName of claimNames) {
				const claim = await read<{ metadata?: OwnedMeta }>(
					persistentVolumeClaimPath(namespace, name, claimName),
					signal,
				)
				const claimUid = claim.metadata?.uid
				const claimVersion = claim.metadata?.resourceVersion
				if (
					typeof claimUid !== 'string' ||
					!claimUid ||
					typeof claimVersion !== 'string' ||
					!claimVersion ||
					claim.metadata?.deletionTimestamp != null ||
					!claim.metadata?.ownerReferences?.some(
						(ref) => ref.uid === uid && ref.controller === true,
					) ||
					(expected && claimUid !== expected.volumeClaimUids[claimName]) ||
					(repeated && (claimUid !== claims[claimName] || claimVersion !== versions[claimName]))
				)
					fail()
				claims[claimName] = claimUid
				versions[claimName] = claimVersion
			}
		}
		async function readPods() {
			const owned: OwnedPod[] = []
			const seen = new Set<string>()
			let continuation = ''
			for (let page = 0; page < 10; page++) {
				const query = new URLSearchParams({
					limit: '1000',
					...(continuation ? { continue: continuation } : {}),
				})
				const result = await read<{
					items?: OwnedPod[]
					metadata?: { continue?: string }
				}>(`${podCollectionPath(namespace)}?${query}`, signal)
				if (!Array.isArray(result.items) || result.items.length > 1000) fail()
				for (const pod of result.items) {
					const podUid = pod.metadata?.uid
					if (typeof podUid !== 'string' || !podUid || seen.has(podUid)) fail()
					seen.add(podUid)
					const isOwned = pod.metadata?.ownerReferences?.some(
						(ref) => ref.uid === uid && ref.controller === true,
					)
					if (pod.metadata?.name === name && !isOwned) fail()
					if (isOwned) {
						if (!pod.status?.phase) fail()
						owned.push(pod)
					}
				}
				const next = result.metadata?.continue
				if (next !== undefined && (typeof next !== 'string' || next.length > 8192)) fail()
				continuation = next ?? ''
				if (!continuation) return owned
			}
			return fail()
		}
		await readClaims(false)
		const pods = await readPods()
		await readClaims(true)
		const confirmedPods = await readPods()
		const podEvidence = (values: readonly OwnedPod[]) =>
			JSON.stringify(
				values
					.map((pod) => ({
						uid: pod.metadata?.uid,
						name: pod.metadata?.name,
						deletionTimestamp: pod.metadata?.deletionTimestamp,
						phase: pod.status?.phase,
						podIP: readPodIP(pod),
					}))
					.sort((a, b) => String(a.uid).localeCompare(String(b.uid))),
			)
		if (podEvidence(pods) !== podEvidence(confirmedPods)) fail()
		const last = await read<SandboxResource>(sandboxPath(namespace, name), signal)
		if (expectedAllocation) assertWorkspaceAllocationResource(workspaceId, expectedAllocation, last)
		if (
			last.metadata?.uid !== uid ||
			last.metadata?.resourceVersion !== version ||
			last.metadata?.deletionTimestamp != null ||
			last.spec?.operatingMode !== mode ||
			readHolderEpoch(last.metadata).epoch !== epoch
		)
			fail()
		if (
			pods.filter((pod) => !isPodStopped(pod)).length > 1 ||
			(mode === 'Suspended' && pods.some((pod) => !isPodStopped(pod)))
		)
			fail()
		return {
			sandbox: last,
			resourceVersion: version,
			identity: capturedIdentity({ sandboxUid: uid, volumeClaimUids: claims }),
			epoch,
			mode,
			pods,
		}
	}
	return { client, namespace, name, fail, owner }
}

/** Discover an existing disk without creating, waking, or contacting a guest. */
export async function inspectKubernetesWorkspaceVolume(
	inputConfig: KubernetesBackendInternalConfig,
	workspaceId: string,
	options: KubernetesWorkspaceVolumeInspectOptions,
): Promise<KubernetesWorkspaceVolumeObservation> {
	const expectedAllocation =
		options.expectedAllocation === undefined
			? undefined
			: captureWorkspaceAllocation(options.expectedAllocation)
	const config = expectedAllocation?.executionProfile
		? workspaceConfigForOriginalProfile(inputConfig, expectedAllocation.executionProfile)
		: inputConfig
	const epoch = checkedEpoch(options.epoch)
	const runtime = volumeRuntime(
		config,
		workspaceId,
		options.requireConfiguredProfile,
		expectedAllocation,
	)
	const deadline = new OperationDeadline(
		30_000,
		`workspace ${workspaceId} volume inspection`,
		options.signal,
	)
	return deadline.run(async (signal) => {
		const found = await runtime.owner(signal)
		if (found.epoch !== epoch) runtime.fail()
		return Object.freeze({ identity: found.identity, epoch, mode: found.mode })
	})
}

/** The caller must persist this disk identity and exclude workload admission
 * before calling. Failure leaves that exclusion owned by the host: no cleanup
 * here may stop, recreate or relabel a disk. */
export async function openKubernetesWorkspaceVolumeForClosure(
	inputConfig: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceVolumeOpenOptions,
): Promise<KubernetesWorkspace> {
	const expectedAllocation =
		options.expectedAllocation === undefined
			? undefined
			: captureWorkspaceAllocation(options.expectedAllocation)
	const config = expectedAllocation?.executionProfile
		? workspaceConfigForOriginalProfile(inputConfig, expectedAllocation.executionProfile)
		: inputConfig
	const identity = capturedIdentity(options.identity)
	const previousEpoch = checkedEpoch(options.previousEpoch)
	const epoch = checkedEpoch(options.epoch)
	const workspaceId = options.workspaceId
	const workingDirectory = options.workingDirectory
	if (epoch !== previousEpoch && epoch !== previousEpoch + 1)
		throw new Error('kubernetes: volume closure may advance exactly one epoch')
	const capturedConfig = {
		...config,
		access: { ...config.access },
		...(config.egress ? { egress: { ...config.egress } } : {}),
	}
	const requireConfiguredProfile = options.requireConfiguredProfile === true
	const runtime = volumeRuntime(
		capturedConfig,
		workspaceId,
		requireConfiguredProfile,
		expectedAllocation,
	)
	const readiness = resolveKubernetesReadiness(capturedConfig)
	const deadline = new OperationDeadline(
		readiness.timeoutMs,
		`workspace ${workspaceId} volume closure`,
		options.signal,
	)
	return deadline.run(async (signal) => {
		const first = await runtime.owner(signal, identity)
		if (expectedAllocation?.executionProfile)
			await verifyOriginalWorkspaceAdmission(
				capturedConfig,
				first.sandbox.spec?.podTemplate.metadata?.labels ?? {},
				signal,
			)
		if (epoch === previousEpoch) {
			if (first.epoch !== epoch || first.mode !== 'Running') runtime.fail()
		} else if (first.epoch === previousEpoch) {
			if (first.mode !== 'Suspended') runtime.fail()
			await runtime.client.request(
				'PATCH',
				sandboxPath(runtime.namespace, runtime.name),
				buildHolderEpochPatch({
					reading: readHolderEpoch(first.sandbox.metadata),
					epoch,
					tests: [
						{ op: 'test', path: '/metadata/uid', value: identity.sandboxUid },
						{
							op: 'test',
							path: '/metadata/resourceVersion',
							value: first.resourceVersion,
						},
						{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
					],
					operatingMode: 'Running',
					operatingModeChangedAt: new Date().toISOString(),
				}),
				signal,
				'json',
			)
		} else if (first.epoch !== epoch || first.mode !== 'Running') runtime.fail()
		for (;;) {
			const current = await runtime.owner(signal, identity)
			if (current.epoch !== epoch || current.mode !== 'Running') runtime.fail()
			const binding = bindingFromSandbox(current.sandbox)
			const pod = current.pods.find((entry) => !isPodStopped(entry))
			const podIP = readPodIP(pod)
			if (
				!binding ||
				!pod ||
				!isPodLive(pod) ||
				pod.status?.phase !== 'Running' ||
				pod.metadata?.name !== binding.name ||
				(capturedConfig.agentAddress === 'pod-ip' && !podIP)
			) {
				await deadline.delay(readiness.pollIntervalMs)
				continue
			}
			const podUid = pod.metadata?.uid
			if (!podUid) return runtime.fail()
			if (expectedAllocation?.executionProfile)
				await verifyOriginalWorkspaceAdmission(capturedConfig, pod.metadata?.labels ?? {}, signal)
			let boot: string | undefined
			let changed = false
			const transport = new KubernetesAgentTransport(
				resolveAgentAddress(binding, capturedConfig.agentPort ?? DEFAULT_AGENT_PORT, podUid, {
					mode: capturedConfig.agentAddress ?? 'service',
					...(podIP ? { podIP } : {}),
				}),
				{
					onGuestReply(reply, fromPod) {
						if (fromPod !== podUid) changed = true
						if (reply.guestBootId) {
							if (boot && reply.guestBootId !== boot) changed = true
							boot = reply.guestBootId
						}
					},
				},
			)
			await transport.listSessions(signal)
			if (!boot || changed) return runtime.fail()
			const confirmed = await runtime.owner(signal, identity)
			if (
				confirmed.epoch !== epoch ||
				confirmed.mode !== 'Running' ||
				confirmed.sandbox.metadata?.resourceVersion !== current.sandbox.metadata?.resourceVersion ||
				!confirmed.pods.some((entry) => entry.metadata?.uid === podUid && isPodLive(entry))
			)
				runtime.fail()
			const fullIdentity: KubernetesWorkspaceIdentity = {
				...identity,
				podUid,
				guestBootId: boot,
			}
			return openKubernetesWorkspaceForClosure(capturedConfig, {
				expectedAllocation,
				requireConfiguredProfile,
				workspaceId,
				workingDirectory,
				identity: fullIdentity,
				epoch,
				signal,
			})
		}
	})
}
