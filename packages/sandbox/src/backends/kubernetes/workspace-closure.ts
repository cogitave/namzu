import { OperationDeadline } from '../readiness.js'
import { captureGuestPin } from './guest-pin.js'
import type { KubernetesWorkspaceIdentity } from './identity.js'
import { type KubernetesBackendInternalConfig, clientAccess, clientOptions } from './index.js'
import { KubernetesAlreadyGoneError, createKubernetesClient } from './k8s-client.js'
import {
	type PodResource,
	type SandboxResource,
	isPodStopped,
	persistentVolumeClaimPath,
	podCollectionPath,
	readHolderEpoch,
	sandboxPath,
} from './objects.js'
import { workspaceSandboxName } from './workspace.js'

/** Persist this identity before sending a terminal lifecycle operation. */
export interface KubernetesWorkspaceClosureTarget {
	readonly identity: KubernetesWorkspaceIdentity
	readonly epoch: number
}

export interface KubernetesWorkspaceClosureOptions extends KubernetesWorkspaceClosureTarget {
	readonly signal?: AbortSignal
}

/** Observed physical state, never permission to acquire or mutate a replacement. */
export type KubernetesWorkspaceClosureState = 'live' | 'stopping' | 'suspended' | 'deleted'

export class KubernetesWorkspaceClosureConflictError extends Error {
	override readonly name = 'KubernetesWorkspaceClosureConflictError'
	constructor(readonly workspaceId: string) {
		super(`kubernetes: workspace ${workspaceId} no longer matches its retained closure target`)
	}
}

interface OwnedMetadata {
	readonly uid?: string
	readonly resourceVersion?: string
	readonly ownerReferences?: readonly {
		readonly uid?: string
		readonly controller?: boolean
	}[]
}

/**
 * Reconcile a lost lifecycle reply after a host restart, without a handle.
 * Every request is a GET. Absence alone is insufficient: old dependents must
 * be gone too, and same-name replacement resources are a conflict. The host
 * still owns durable exclusion and capture evidence; this read does not grant
 * either, and must never be used to authorize a new by-name stop.
 */
export async function reconcileKubernetesWorkspaceClosure(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options: KubernetesWorkspaceClosureOptions,
): Promise<KubernetesWorkspaceClosureState> {
	return (await observeClosure(config, workspaceId, options)).state
}

/** Conditional retention of an already captured, suspended disk. No guest is
 * opened; the exact owner and all dependents are read before the only write. */
export async function deleteSuspendedWorkspace(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options: KubernetesWorkspaceClosureOptions,
): Promise<void> {
	const owned = {
		identity: structuredClone(options.identity),
		epoch: options.epoch,
		signal: options.signal,
	}
	const observed = await observeClosure(config, workspaceId, owned)
	if (observed.state === 'deleted') return
	if (observed.state !== 'suspended' || !observed.resourceVersion)
		throw new KubernetesWorkspaceClosureConflictError(workspaceId)
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	await client.request(
		'DELETE',
		sandboxPath(config.namespace, workspaceSandboxName(workspaceId)),
		{
			apiVersion: 'v1',
			kind: 'DeleteOptions',
			preconditions: {
				uid: owned.identity.sandboxUid,
				resourceVersion: observed.resourceVersion,
			},
		},
		owned.signal,
	)
}

async function observeClosure(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options: KubernetesWorkspaceClosureOptions,
): Promise<{
	state: KubernetesWorkspaceClosureState
	resourceVersion?: string
}> {
	const identity: KubernetesWorkspaceIdentity = {
		sandboxUid: options.identity.sandboxUid,
		podUid: options.identity.podUid,
		guestBootId: options.identity.guestBootId,
		volumeClaimUids: { ...options.identity.volumeClaimUids },
	}
	captureGuestPin(identity)
	const epoch = options.epoch
	function fail(): never {
		throw new KubernetesWorkspaceClosureConflictError(workspaceId)
	}
	if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 2_147_483_647) fail()
	const name = workspaceSandboxName(workspaceId)
	const namespace = config.namespace
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const deadline = new OperationDeadline(
		30_000,
		`workspace ${workspaceId} closure observation`,
		options.signal,
	)
	return deadline.run(async (signal) => {
		const read = async <T>(path: string): Promise<T | undefined> => {
			try {
				const value = await client.request<T>('GET', path, undefined, signal)
				// Only the API's explicit 404/410 means absence; an empty 200 is unknown.
				return value === undefined ? fail() : value
			} catch (error) {
				if (error instanceof KubernetesAlreadyGoneError) return undefined
				throw error
			}
		}
		const checkSandbox = (value: SandboxResource | undefined) => {
			if (!value) return
			if (
				value.metadata?.uid !== identity.sandboxUid ||
				!value.metadata?.resourceVersion ||
				readHolderEpoch(value.metadata).epoch !== epoch
			)
				fail()
			const names = value.spec?.volumeClaimTemplates?.map((claim) => claim.metadata?.name)
			if (
				JSON.stringify(names?.sort()) !==
				JSON.stringify(Object.keys(identity.volumeClaimUids).sort())
			)
				fail()
		}
		const first = await read<SandboxResource>(sandboxPath(namespace, name))
		checkSandbox(first)
		const readDependents = async () => {
			let remainingClaims = 0
			const claimEvidence: unknown[] = []
			for (const [claimName, uid] of Object.entries(identity.volumeClaimUids)) {
				const claim = await read<{ metadata?: OwnedMetadata }>(
					persistentVolumeClaimPath(namespace, name, claimName),
				)
				if (!claim) continue
				if (
					claim.metadata?.uid !== uid ||
					!claim.metadata.ownerReferences?.some(
						(owner) => owner.uid === identity.sandboxUid && owner.controller === true,
					)
				)
					fail()
				remainingClaims++
				claimEvidence.push([claimName, uid, claim.metadata.resourceVersion])
			}
			let originalPod: PodResource | undefined
			let continuation = ''
			// A bounded, paginated namespace snapshot finds the captured UID even
			// when the controller did not use the Sandbox's name for its pod.
			for (let page = 0; page < 10; page++) {
				const query = new URLSearchParams({
					limit: '1000',
					...(continuation ? { continue: continuation } : {}),
				})
				const pods = await read<{
					items?: readonly (PodResource & {
						metadata?: OwnedMetadata & { name?: string }
					})[]
					metadata?: { continue?: string }
				}>(`${podCollectionPath(namespace)}?${query}`)
				if (!pods || !Array.isArray(pods.items)) fail()
				const items: readonly (PodResource & {
					metadata?: OwnedMetadata & { name?: string }
				})[] = pods.items
				for (const pod of items) {
					if (!pod.metadata?.uid) fail()
					const owned = pod.metadata.ownerReferences?.some(
						(owner) => owner.uid === identity.sandboxUid && owner.controller === true,
					)
					if (pod.metadata.uid === identity.podUid) {
						if (!owned || originalPod) fail()
						originalPod = pod
					} else if (owned || pod.metadata.name === name) fail()
				}
				continuation = pods.metadata?.continue ?? ''
				if (!continuation) break
				if (page === 9) fail()
			}
			return {
				remainingClaims,
				originalPod,
				fingerprint: JSON.stringify([claimEvidence, originalPod ?? null]),
			}
		}
		const dependents = await readDependents()
		const middle = await read<SandboxResource>(sandboxPath(namespace, name))
		checkSandbox(middle)
		// A changing owner view cannot close durable host state. Retry is a
		// caller decision under its retained lease, never an internal adoption.
		const ownerEvidence = (value: SandboxResource | undefined) =>
			JSON.stringify([
				value?.metadata?.uid,
				value?.metadata?.resourceVersion,
				value?.metadata?.deletionTimestamp,
				value?.spec?.operatingMode,
				value ? readHolderEpoch(value.metadata).epoch : undefined,
			])
		if (ownerEvidence(first) !== ownerEvidence(middle)) fail()
		let state: KubernetesWorkspaceClosureState
		if (!middle)
			state = dependents.remainingClaims || dependents.originalPod ? 'stopping' : 'deleted'
		else if (middle.metadata?.deletionTimestamp) state = 'stopping'
		else {
			if (dependents.remainingClaims !== Object.keys(identity.volumeClaimUids).length) fail()
			state =
				middle.spec?.operatingMode === 'Suspended'
					? !dependents.originalPod || isPodStopped(dependents.originalPod)
						? 'suspended'
						: 'stopping'
					: 'live'
		}
		if (state === 'deleted' || state === 'suspended') {
			const confirmed = await readDependents()
			const last = await read<SandboxResource>(sandboxPath(namespace, name))
			checkSandbox(last)
			if (
				ownerEvidence(middle) !== ownerEvidence(last) ||
				dependents.fingerprint !== confirmed.fingerprint
			)
				fail()
		}
		return { state, resourceVersion: middle?.metadata?.resourceVersion }
	})
}
