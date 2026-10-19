/**
 * What an allocated workspace carries, and what it takes to refuse one that
 * is not the allocation a host expects.
 *
 * `allocateKubernetesWorkspace` records three facts on the Sandbox in the one
 * create request — see {@link ALLOCATION_ID_ANNOTATION_KEY},
 * {@link ALLOCATION_SCOPE_ANNOTATION_KEY} and
 * {@link EXECUTION_PROFILE_ANNOTATION_KEY}. A host that persisted the same
 * three before the create can later hand them back as `expectedAllocation`
 * to `inspectKubernetesWorkspace`, `openKubernetesWorkspace` and
 * `reconcileKubernetesWorkspace`, and a Sandbox standing under the name that
 * does not carry them is refused with
 * {@link KubernetesWorkspaceAllocationMismatchError}, whoever made it.
 *
 * This file imports nothing from the workspace modules: both the read side
 * (`workspace-observe.ts`) and the create side (`workspace-allocate.ts`) need
 * it, and neither may import the other.
 */

import {
	POD_TEMPLATE_HASH_ANNOTATION_KEY,
	type SandboxResource,
	canonicalFingerprint,
	readAllocation,
} from './objects.js'

/** The longest allocation id or scope fingerprint accepted, in UTF-16 units. */
export const MAX_ALLOCATION_FIELD_LENGTH = 1024

/**
 * The allocation a host expects a workspace to belong to.
 *
 *  - `id` — the host's immutable allocation id.
 *  - `scopeFingerprint` — the host's opaque scope string. Compared for
 *    equality only.
 *  - `executionProfile` — optional. The fingerprint
 *    `resolveKubernetesExecutionProfile` returned. On `allocate` it is what
 *    the profile resolved NOW must still equal (a profile that moved since
 *    the host persisted it refuses the create); on `inspect`, `open` and
 *    `reconcile` it is compared with the annotation stored at creation.
 *    Omitted on the read side, the profile annotation is not compared.
 */
export interface KubernetesWorkspaceAllocation {
	readonly id: string
	readonly scopeFingerprint: string
	readonly executionProfile?: string
}

/** The allocation a workspace reports; fields are `undefined` where the annotation is absent. */
export interface KubernetesObservedAllocation {
	readonly id: string | undefined
	readonly scopeFingerprint: string | undefined
	readonly executionProfile: string | undefined
}

/**
 * Which part of the expected allocation did not hold.
 *
 *  - `allocation-id`, `scope-fingerprint`, `execution-profile` — the
 *    annotation is absent or differs.
 *  - `template-content` — the pod template the Sandbox carries now does not
 *    hash to the revision annotation written with it (the copy was edited
 *    after creation), or that annotation is gone.
 */
export type KubernetesWorkspaceAllocationMismatch =
	| 'allocation-id'
	| 'scope-fingerprint'
	| 'execution-profile'
	| 'template-content'

/**
 * A Sandbox stands under the workspace's name and is not the allocation the
 * host expected: its annotations differ, or its copied pod template is not
 * the content that was recorded. Nothing was created, woken or written to
 * reach this. Terminal: retrying finds the same object.
 */
export class KubernetesWorkspaceAllocationMismatchError extends Error {
	override readonly name = 'KubernetesWorkspaceAllocationMismatchError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
		readonly mismatch: KubernetesWorkspaceAllocationMismatch,
		/** What the host expected for the thing that differs. */
		readonly expected: string | undefined,
		/** What the object carries; `undefined` when the annotation is absent. */
		readonly actual: string | undefined,
	) {
		super(
			`kubernetes: workspace ${workspaceId} (Sandbox ${sandboxName}) is not the allocation this host expected — ${mismatch}: expected ${JSON.stringify(
				expected,
			)}, found ${JSON.stringify(
				actual,
			)}. Nothing was created, woken or written. Whatever stands under the name was not allocated for this request, or was altered after it was.`,
		)
	}
}

/** A Sandbox already stands under the workspace's name; `allocate` never adopts it. */
export class KubernetesWorkspaceAllocationConflictError extends Error {
	override readonly name = 'KubernetesWorkspaceAllocationConflictError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
	) {
		super(
			`kubernetes: cannot allocate workspace ${workspaceId}: a Sandbox named ${sandboxName} already exists. allocateKubernetesWorkspace never adopts, wakes or modifies an existing object, so nothing was changed. If an earlier allocate of this same allocation got no reply, find out with recoverKubernetesWorkspaceAllocation (read-only); otherwise the name belongs to something else.`,
		)
	}
}

/**
 * The execution profile resolved now is not the one the host captured, so
 * nothing was created. The host's persisted record is stale (a template, an
 * overlay or a policy changed) and has to be captured again on purpose.
 */
export class KubernetesExecutionProfileDriftError extends Error {
	override readonly name = 'KubernetesExecutionProfileDriftError'

	constructor(
		readonly workspaceId: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(
			`kubernetes: cannot allocate workspace ${workspaceId}: the execution profile resolves to ${actual} now, but the allocation captured ${expected}. Nothing was created. Resolve the profile again, persist it, and allocate against the new one.`,
		)
	}
}

/** Refuse an allocation that cannot be stored or compared as given. */
export function assertAllocation(allocation: KubernetesWorkspaceAllocation, where: string): void {
	const check = (label: string, value: unknown): void => {
		if (typeof value !== 'string' || value === '' || value.length > MAX_ALLOCATION_FIELD_LENGTH) {
			throw new TypeError(
				`kubernetes: ${where} needs ${label} to be a non-empty string of at most ${MAX_ALLOCATION_FIELD_LENGTH} characters, got ${
					typeof value === 'string' ? `${value.length} characters` : typeof value
				}.`,
			)
		}
	}
	if (typeof allocation !== 'object' || allocation === null) {
		throw new TypeError(`kubernetes: ${where} needs an allocation: { id, scopeFingerprint }.`)
	}
	check('allocation.id', allocation.id)
	check('allocation.scopeFingerprint', allocation.scopeFingerprint)
	if (allocation.executionProfile !== undefined) {
		check('allocation.executionProfile', allocation.executionProfile)
	}
}

/** What the Sandbox's annotations say its allocation is. */
export function observedAllocation(sandbox: SandboxResource): KubernetesObservedAllocation {
	return readAllocation(sandbox.metadata)
}

/**
 * The first way `sandbox` is not the expected allocation, or `undefined`.
 *
 * Order: id, scope, profile (when expected), then the copied template. The
 * template check recomputes the canonical hash of the `spec.podTemplate` the
 * Sandbox carries and compares it with the revision annotation written in the
 * same create — it detects a copy edited afterwards, and it does not compare
 * against the SandboxTemplate as it is now (a template edit that reaches
 * only later workspaces is not drift of THIS one).
 */
export function firstAllocationMismatch(
	sandbox: SandboxResource,
	expected: KubernetesWorkspaceAllocation,
): { kind: KubernetesWorkspaceAllocationMismatch; expected?: string; actual?: string } | undefined {
	const actual = readAllocation(sandbox.metadata)
	const differs = (
		kind: KubernetesWorkspaceAllocationMismatch,
		want: string,
		have: string | undefined,
	) => ({ kind, expected: want, ...(have !== undefined ? { actual: have } : {}) })
	if (actual.id !== expected.id) return differs('allocation-id', expected.id, actual.id)
	if (actual.scopeFingerprint !== expected.scopeFingerprint) {
		return differs('scope-fingerprint', expected.scopeFingerprint, actual.scopeFingerprint)
	}
	if (
		expected.executionProfile !== undefined &&
		actual.executionProfile !== expected.executionProfile
	) {
		return differs('execution-profile', expected.executionProfile, actual.executionProfile)
	}
	const recorded = sandbox.metadata?.annotations?.[POD_TEMPLATE_HASH_ANNOTATION_KEY]
	const podTemplate = sandbox.spec?.podTemplate
	const current = podTemplate === undefined ? undefined : canonicalFingerprint(podTemplate)
	if (recorded === undefined || current !== recorded) {
		return {
			kind: 'template-content',
			...(recorded !== undefined ? { expected: recorded } : {}),
			...(current !== undefined ? { actual: current } : {}),
		}
	}
	return undefined
}
