import type { KubernetesObjectMeta, SandboxResource } from './objects.js'
import {
	type KubernetesWorkspaceExecutionProfile,
	assertWorkspaceExecutionContent,
	captureWorkspaceExecutionProfile,
} from './workspace-profile.js'

export interface KubernetesWorkspaceAllocation {
	/** Immutable host attempt identity, persisted before the create request. */
	readonly id: string
	/** Fingerprint of the immutable task, project, environment and profile scope. */
	readonly scopeFingerprint: string
	/** Native callers retain the resolved original content before CREATE. */
	readonly executionProfile?: KubernetesWorkspaceExecutionProfile
}

export interface KubernetesWorkspaceAllocateOptions {
	readonly workspaceId: string
	readonly allocation: KubernetesWorkspaceAllocation
	readonly epoch: number
	readonly signal?: AbortSignal
}

/** A create acknowledgement, not a ready guest or complete disk admission. */
export interface KubernetesWorkspaceAllocationReceipt {
	readonly workspaceId: string
	readonly allocation: KubernetesWorkspaceAllocation
	readonly epoch: number
	readonly sandboxUid: string
}

export const WORKSPACE_ALLOCATION_ID_ANNOTATION = 'sandbox.namzu.ai/allocation-id'
export const WORKSPACE_ALLOCATION_SCOPE_ANNOTATION = 'sandbox.namzu.ai/allocation-scope'
export const WORKSPACE_ALLOCATION_PROFILE_ANNOTATION = 'sandbox.namzu.ai/allocation-profile'

export class KubernetesWorkspaceAllocationConflictError extends Error {
	override readonly name = 'KubernetesWorkspaceAllocationConflictError'
	constructor(
		readonly workspaceId: string,
		options?: ErrorOptions,
	) {
		super(
			`kubernetes: workspace ${workspaceId} does not prove the original allocation; no adoption or wake is authorized`,
			options,
		)
	}
}

export function captureWorkspaceAllocation(
	value: KubernetesWorkspaceAllocation,
): KubernetesWorkspaceAllocation {
	const id = value?.id
	const scopeFingerprint = value?.scopeFingerprint
	if (
		typeof id !== 'string' ||
		!id ||
		id.length > 200 ||
		id.includes('\0') ||
		typeof scopeFingerprint !== 'string' ||
		!/^[a-f0-9]{64}$/.test(scopeFingerprint)
	)
		throw new Error(
			'kubernetes: allocation requires a bounded original id and SHA256 scope fingerprint',
		)
	return Object.freeze({
		id,
		scopeFingerprint,
		...(value.executionProfile !== undefined
			? {
					executionProfile: captureWorkspaceExecutionProfile(value.executionProfile),
				}
			: {}),
	})
}

export function assertWorkspaceAllocation(
	workspaceId: string,
	expected: KubernetesWorkspaceAllocation,
	metadata: KubernetesObjectMeta | undefined,
): void {
	if (
		metadata?.annotations?.[WORKSPACE_ALLOCATION_ID_ANNOTATION] !== expected.id ||
		metadata?.annotations?.[WORKSPACE_ALLOCATION_SCOPE_ANNOTATION] !== expected.scopeFingerprint ||
		(metadata?.annotations?.[WORKSPACE_ALLOCATION_PROFILE_ANNOTATION] !== undefined &&
			!expected.executionProfile) ||
		(expected.executionProfile &&
			metadata?.annotations?.[WORKSPACE_ALLOCATION_PROFILE_ANNOTATION] !==
				expected.executionProfile.fingerprint)
	)
		throw new KubernetesWorkspaceAllocationConflictError(workspaceId)
}

/** The profile annotation is provenance, never a substitute for the actual
 * copied Sandbox content. Every owner read that authorizes a write uses both. */
export function assertWorkspaceAllocationResource(
	workspaceId: string,
	expected: KubernetesWorkspaceAllocation,
	resource: SandboxResource | undefined,
): void {
	assertWorkspaceAllocation(workspaceId, expected, resource?.metadata)
	if (expected.executionProfile)
		assertWorkspaceExecutionContent(expected.executionProfile, resource?.spec)
}
