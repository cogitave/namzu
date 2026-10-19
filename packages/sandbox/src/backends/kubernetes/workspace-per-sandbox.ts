/**
 * Per-sandbox egress on a workspace: the pieces `createKubernetesWorkspace`,
 * `allocateKubernetesWorkspace` and a workspace handle share.
 *
 * ## The shape, and where it differs from a task sandbox
 *
 *  - **Label.** The per-sandbox selector label rides on the workspace's
 *    directly created `Sandbox` pod template, composed by
 *    `composeAdditionalPodLabels` beside the egress profile. Its VALUE is the
 *    Sandbox's own name, `namzu-ws-<workspaceId>`: deterministic, known before
 *    the POST, and stable across a suspend and a resume, because a resume
 *    patches `operatingMode` and the pod template (labels included) is carried
 *    by the object, not by the pod.
 *  - **Owner.** The `Sandbox` itself. A policy names it in `ownerReferences`
 *    with its `metadata.uid`, so deleting the workspace (`destroy({ deleteDisk:
 *    true })`, `deleteKubernetesWorkspace`) lets the cluster's garbage
 *    collector remove every policy it owns. The default `destroy()` only
 *    suspends, keeps the object, and so keeps the policy.
 *  - **Name.** `namzu-sbx-<sandbox uid>`, the same rule as a task sandbox. The
 *    workspace NAME is deterministic and its uid is not, so a workspace deleted
 *    and created again under the same name selects by the same label value
 *    and owns a policy of a different name.
 *
 * ## Suspend and resume
 *
 * The behaviour is one rule, applied on every path that is about to run the
 * workspace's pod: a resume, and an open of an existing workspace.
 *
 *  1. The admission fence is re-verified from scratch (never from a memo). A
 *     fence that is missing or would not enforce REFUSES the resume, before
 *     the patch: the workspace stays suspended, which is the only state that
 *     is safe without the fence, and nothing is written.
 *  2. Every per-sandbox policy in the namespace that selects this workspace
 *     (name prefix `namzu-sbx-`, selector label value equal to the Sandbox's
 *     name) and that this Sandbox does not own (no `ownerReferences` entry of
 *     kind `Sandbox` with this name and the uid the cluster reports NOW) is
 *     deleted. Such a policy belongs to a workspace that was deleted and
 *     created again under the same name and has not been garbage-collected
 *     yet; left alone it would grant the new workspace what the old one's
 *     consent covered.
 *  3. A policy this Sandbox owns is KEPT, unchanged. A suspend is not a
 *     revocation: the grant was admitted by the fence when it was written and
 *     the resumed pod carries the same label, so the policy applies to it
 *     again. A host that wants the grant gone calls `setNetworkPolicy({
 *     allowedHosts: [] })` (which deletes it) before it suspends.
 *
 * A freshly created workspace gets step 2 after the create reply, with the uid
 * the reply carried.
 *
 * ## What is NOT proven here
 *
 * That any of it is enforced. Enforcement is the CNI's data plane: it needs a
 * cluster running Cilium, the same as the task path.
 */

import type { KubernetesEgressConfig, KubernetesPerSandboxEgressConfig } from './egress-policy.js'
import { perSandboxEgressLabelKey } from './egress-policy.js'
import { KubernetesAlreadyGoneError, type KubernetesClient } from './k8s-client.js'
import { ciliumNetworkPolicyCollectionPath, ciliumNetworkPolicyPath } from './objects.js'
import { PER_SANDBOX_POLICY_NAME_PREFIX, type PerSandboxPolicyFence } from './per-sandbox-policy.js'

/** The profile variant a workspace with per-sandbox egress configured carries. */
export const KUBERNETES_PER_SANDBOX_PROFILE_VARIANT = 'core/no-network+per-sandbox'

/**
 * The extra pod-label map a workspace named `sandboxName` contributes to
 * `composeAdditionalPodLabels`, or `undefined` when `perSandbox` is not
 * configured, which is what keeps that workspace's request log unchanged.
 */
export function perSandboxWorkspaceLabels(
	egress: KubernetesEgressConfig | undefined,
	sandboxName: string,
): Readonly<Record<string, string>> | undefined {
	const key = perSandboxEgressLabelKey(egress)
	return key === undefined ? undefined : { [key]: sandboxName }
}

/** `labels` without the per-sandbox key `extra` carries; `labels` itself when there is none. */
export function withoutPerSandboxLabel(
	labels: Readonly<Record<string, string>>,
	extra: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
	if (extra === undefined) return labels
	return Object.fromEntries(Object.entries(labels).filter(([key]) => !(key in extra)))
}

/** What a list of CiliumNetworkPolicies answers with. */
interface CiliumPolicyList {
	readonly items?: readonly {
		readonly metadata?: {
			readonly name?: string
			readonly ownerReferences?: readonly {
				readonly kind?: string
				readonly name?: string
				readonly uid?: string
			}[]
		}
		readonly spec?: {
			readonly endpointSelector?: { readonly matchLabels?: Readonly<Record<string, unknown>> }
		}
	}[]
}

/**
 * The names of the per-sandbox policies this workspace's label selects and
 * its Sandbox does not own. Read only.
 */
export async function findForeignPerSandboxPolicies(
	client: KubernetesClient,
	namespace: string,
	labelKey: string,
	sandboxName: string,
	ownerUid: string,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	const list = await client.request<CiliumPolicyList>(
		'GET',
		ciliumNetworkPolicyCollectionPath(namespace),
		undefined,
		signal,
	)
	const foreign: string[] = []
	for (const item of list?.items ?? []) {
		const name = item?.metadata?.name
		if (typeof name !== 'string' || !name.startsWith(PER_SANDBOX_POLICY_NAME_PREFIX)) continue
		if (item?.spec?.endpointSelector?.matchLabels?.[labelKey] !== sandboxName) continue
		const owned = (item.metadata?.ownerReferences ?? []).some(
			(ref) => ref?.kind === 'Sandbox' && ref.name === sandboxName && ref.uid === ownerUid,
		)
		if (!owned) foreign.push(name)
	}
	return foreign
}

/** What {@link reverifyPerSandboxEgress} needs. */
export interface PerSandboxReverification {
	readonly client: KubernetesClient
	readonly namespace: string
	readonly sandboxName: string
	/** The uid the cluster reports for the Sandbox NOW. */
	readonly ownerUid: string
	readonly egress: KubernetesEgressConfig & {
		readonly perSandbox: KubernetesPerSandboxEgressConfig
	}
	/** A fence whose memo has not been used yet. */
	readonly fence: PerSandboxPolicyFence
	readonly signal?: AbortSignal
}

/**
 * Steps 1 and 2 of the resume rule above: prove the fence, then delete the
 * policies that select this workspace and that its Sandbox does not own.
 * Returns the names it deleted. Throws the fence's own refusal, having
 * written nothing, when the fence does not verify.
 */
export async function reverifyPerSandboxEgress(
	options: PerSandboxReverification,
): Promise<readonly string[]> {
	const { client, namespace, sandboxName, ownerUid, egress, fence, signal } = options
	await fence.assertApplied(signal)
	const labelKey = perSandboxEgressLabelKey(egress)
	if (labelKey === undefined) return []
	const foreign = await findForeignPerSandboxPolicies(
		client,
		namespace,
		labelKey,
		sandboxName,
		ownerUid,
		signal,
	)
	for (const name of foreign) {
		try {
			await client.request('DELETE', ciliumNetworkPolicyPath(namespace, name), undefined, signal)
		} catch (err) {
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
		}
	}
	return foreign
}
