/**
 * Wire shapes and paths for the agent-sandbox CRDs this backend touches.
 *
 * Every field name here was read off the CRDs a real cluster serves —
 * `kubectl get crd -o json` against agent-sandbox v1.0.2 on a kind cluster —
 * and cross-checked against the upstream `sandbox_types.go` /
 * `sandboxclaim_types.go` doc comments. Where the two disagree the served CRD
 * wins, because it is what the API server validates against: the Go source on
 * upstream main has already moved `Sandbox`'s `shutdownTime` /
 * `shutdownPolicy` under a `lifecycle` block, and v1beta1 as served still
 * carries them at the top of `spec`.
 *
 * The shapes are deliberately partial. This backend reads four fields out of a
 * Sandbox status and writes three into a claim spec; typing the rest of a
 * PodSpec would be a vendored copy of the core API that goes stale on its own
 * schedule. A pod template read from a SandboxTemplate is carried through as
 * an opaque record for exactly that reason — it is copied, never interpreted.
 *
 * Two groups, both `v1beta1` and both singular-versioned today:
 *   - `agents.x-k8s.io`            → sandboxes
 *   - `extensions.agents.x-k8s.io` → sandboxtemplates, sandboxwarmpools,
 *                                    sandboxclaims
 */

/** Group serving the `Sandbox` kind. */
export const SANDBOX_API_GROUP = 'agents.x-k8s.io'
/** Group serving `SandboxTemplate`, `SandboxWarmPool` and `SandboxClaim`. */
export const SANDBOX_EXTENSIONS_API_GROUP = 'extensions.agents.x-k8s.io'
/** The only version either group serves in agent-sandbox v1.0.2. */
export const SANDBOX_API_VERSION = 'v1beta1'

/** `status.conditions[].type` both kinds report readiness under. */
export const READY_CONDITION = 'Ready'

// The controller also reports a `Suspended` condition, and this backend
// deliberately does NOT model or read it. Upstream's own `sandbox_types.go`
// says why: "the controller does not currently remove this condition when the
// Sandbox is resumed, so a stale Suspended condition may linger after
// operatingMode returns to Running. Consumers should treat Ready as the
// authoritative signal and not infer the live operating state from the mere
// presence of this condition." A suspend that waited on it would return on the
// True left behind by the previous suspend, while the guest was still running
// and still writing. `workspace.ts` waits on the pod instead — see
// `isPodStopped` below.

export interface KubernetesObjectMeta {
	readonly name?: string
	readonly namespace?: string
	readonly uid?: string
	/**
	 * RFC 3339, written by the API server on admission and never by a client.
	 * Read only to report how old a workspace is — see
	 * `workspace.ts`'s `listKubernetesWorkspaces`.
	 */
	readonly creationTimestamp?: string
	/**
	 * Set the moment a DELETE is accepted, long before the object goes away.
	 * A pod that carries one is on its way out and must never be bound to —
	 * see {@link isPodLive}.
	 */
	readonly deletionTimestamp?: string
	readonly labels?: Readonly<Record<string, string>>
	readonly annotations?: Readonly<Record<string, string>>
}

/** `metav1.Condition`, as both CRDs embed it. */
export interface KubernetesCondition {
	readonly type: string
	readonly status: 'True' | 'False' | 'Unknown'
	readonly reason?: string
	readonly message?: string
	readonly lastTransitionTime?: string
}

/**
 * True only for an explicit `status: 'True'`. An absent condition, an
 * `Unknown` and a `False` are all "not yet", never "assume so" — the
 * controller writes `Unknown` while it is still deciding.
 */
export function isConditionTrue(
	conditions: readonly KubernetesCondition[] | undefined,
	type: string,
): boolean {
	return conditions?.some((c) => c.type === type && c.status === 'True') === true
}

/**
 * `SandboxClaim.spec.lifecycle`.
 *
 * `shutdownTime` is the only one of the three that bounds a claim whose owner
 * disappeared: the controller deletes the claim's resources once the wall
 * clock reaches it, whatever the claim is doing. `ttlSecondsAfterFinished`
 * reads like the leak guard and is not one — upstream's own comment says "the
 * timer starts from the mirrored Finished condition's LastTransitionTime", so
 * a claim whose host crashed before finishing never starts that clock.
 */
export interface SandboxClaimLifecycle {
	/** RFC 3339. Absolute expiry; the claim never expires without it. */
	readonly shutdownTime?: string
	/**
	 * What happens to the claim OBJECT at expiry. `Retain` (the CRD default)
	 * deletes the Sandbox, Pod and Service but leaves the claim behind, so a
	 * host that crashes daily accumulates claims forever.
	 */
	readonly shutdownPolicy?: 'Delete' | 'DeleteForeground' | 'Retain'
	readonly ttlSecondsAfterFinished?: number
}

/**
 * `SandboxClaim.spec`. `warmPoolRef` is REQUIRED by the CRD, which is why
 * there is no such thing as a pool-less claim and the no-pool path has to
 * create a Sandbox directly.
 *
 * `env` and `volumeClaimTemplates` exist on this spec and are deliberately
 * absent from this type: setting either forces the claim to cold-start rather
 * than adopt a warm pool sandbox, which is the one thing the warm path exists
 * to avoid. A field that cannot be named cannot be set by accident.
 */
export interface SandboxClaimResourceSpec {
	readonly warmPoolRef: { readonly name: string }
	readonly lifecycle?: SandboxClaimLifecycle
}

/**
 * `SandboxClaim.status`. `sandbox` is the whole reason the claim path reads
 * status back: an adopted pool sandbox keeps the generated name the pool gave
 * it, so the bound object is routinely NOT named after the claim.
 */
export interface SandboxClaimResourceStatus {
	readonly conditions?: readonly KubernetesCondition[]
	readonly sandbox?: {
		readonly name?: string
		readonly podIPs?: readonly string[]
		readonly serviceFQDN?: string
	}
}

export interface SandboxClaimResource {
	readonly apiVersion?: string
	readonly kind?: string
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: SandboxClaimResourceSpec
	readonly status?: SandboxClaimResourceStatus
}

/**
 * `podTemplate` on a Sandbox or a SandboxTemplate. `spec` is a core `PodSpec`,
 * carried opaquely: this backend copies one from a template into a Sandbox and
 * overlays at most `runtimeClassName`.
 */
export interface SandboxPodTemplate {
	readonly metadata?: KubernetesObjectMeta
	readonly spec: Readonly<Record<string, unknown>>
}

/**
 * One `spec.volumeClaimTemplates` entry.
 *
 * Partial in the same way every other shape here is: a workspace's disk is
 * COPIED verbatim from the `SandboxTemplate` that declares it, and only the
 * two fields this backend has to reason about are named — the entry's own
 * `metadata.name`, which is how the controller wires the mount (StatefulSet
 * style: the PVC is created as `<entry name>-<sandbox name>` and no explicit
 * `volumes:` entry is needed in the podTemplate), and `spec.volumeMode`,
 * which decides whether the guest gets a raw block device or a filesystem
 * passthrough. The index signatures carry everything else across untouched.
 */
export interface SandboxVolumeClaimTemplate {
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: {
		readonly volumeMode?: string
		readonly [field: string]: unknown
	}
	readonly [field: string]: unknown
}

export interface SandboxResourceSpec {
	readonly operatingMode?: 'Running' | 'Suspended'
	readonly podTemplate: SandboxPodTemplate
	/** Create a headless Service, and with it a `status.serviceFQDN`. */
	readonly service?: boolean
	readonly shutdownPolicy?: 'Delete' | 'Retain'
	/** RFC 3339, top-level on v1beta1 Sandbox (NOT under `lifecycle`). */
	readonly shutdownTime?: string
	/**
	 * CEL-immutable on the served CRD ("volumeClaimTemplates is immutable"),
	 * which is why a workspace's disk has to be in the spec from creation and
	 * cannot be attached to a sandbox that is already running.
	 */
	readonly volumeClaimTemplates?: readonly SandboxVolumeClaimTemplate[]
}

/**
 * `Sandbox.status`. Note what is NOT here: a pod name. The backing pod is
 * named after the Sandbox itself in v1.0.2, and `selector` — a serialised
 * label selector, e.g. `agents.x-k8s.io/sandbox-name-hash=<hash>` — is the
 * only thing in the API that finds the pod without relying on that.
 */
export interface SandboxResourceStatus {
	readonly conditions?: readonly KubernetesCondition[]
	readonly nodeName?: string
	readonly podIPs?: readonly string[]
	readonly selector?: string
	readonly service?: string
	readonly serviceFQDN?: string
}

export interface SandboxResource {
	readonly apiVersion?: string
	readonly kind?: string
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: SandboxResourceSpec
	readonly status?: SandboxResourceStatus
}

/**
 * A `GET` of the sandboxes COLLECTION. `items` is the only field anything
 * here reads: this backend does no watch, so `metadata.resourceVersion` and
 * `continue` have nothing to feed — the namespace a deployment gives its
 * sandboxes holds tens of objects, not the thousands that would make a page
 * boundary a real answer rather than a truncated one.
 */
export interface SandboxListResource {
	readonly items?: readonly SandboxResource[]
}

export interface SandboxTemplateResource {
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: {
		readonly podTemplate?: SandboxPodTemplate
		readonly service?: boolean
		readonly volumeClaimTemplates?: readonly SandboxVolumeClaimTemplate[]
	}
}

/**
 * `metadata.uid` is the per-instance agent bind token; `deletionTimestamp`
 * and `phase` exist only to answer "is this the pod that uid belongs to, or
 * the one being deleted?" — see {@link isPodLive}.
 *
 * `podIP` is read by the `pod-ip` address mode only, and deliberately from
 * the SAME object the uid comes from: an address taken from one pod and a
 * token taken from another is the mismatch that reports as a flat
 * `unauthorized` with nothing pointing at the pod that was replaced in
 * between. Both spellings are carried because a dual-stack cluster fills
 * `podIPs` and single-stack clusters have always filled `podIP`; the API
 * server sets `podIP` to the first entry of `podIPs` on every cluster that
 * sets either, so {@link readPodIP} prefers it and falls back.
 */
export interface PodResource {
	readonly metadata?: KubernetesObjectMeta
	readonly status?: {
		readonly phase?: string
		readonly podIP?: string
		readonly podIPs?: readonly { readonly ip?: string }[]
	}
}

/** The pod's own address, whichever of the two fields this cluster fills. */
export function readPodIP(pod: PodResource | undefined): string | undefined {
	const status = pod?.status
	if (typeof status?.podIP === 'string' && status.podIP !== '') return status.podIP
	for (const entry of status?.podIPs ?? []) {
		if (typeof entry?.ip === 'string' && entry.ip !== '') return entry.ip
	}
	return undefined
}

export interface PodListResource {
	readonly items?: readonly PodResource[]
}

/**
 * A pod whose uid is still worth binding to: not being deleted, and not in a
 * phase it cannot leave.
 *
 * The case this exists for is resume. A resumed sandbox's pod keeps the
 * SAME NAME and gets a new uid and a new IP, so while the outgoing pod is
 * terminating a `GET` by that name answers with the pod on its way out, and a
 * list by the sandbox's selector returns every pod still carrying its labels,
 * that one included. Binding to the terminating pod's uid produces a token the
 * new agent refuses, and the failure arrives as a flat `unauthorized` with
 * nothing pointing at the race that caused it.
 */
export function isPodLive(pod: PodResource | undefined): boolean {
	if (!pod?.metadata) return false
	// `!= null`, not `!== undefined`: an explicit JSON null would otherwise
	// read as "terminating" and make a perfectly healthy pod unbindable. The
	// API server omits the field rather than nulling it, so this never fires
	// against a real cluster — it costs nothing not to depend on that.
	if (pod.metadata.deletionTimestamp != null) return false
	const phase = pod.status?.phase
	return phase !== 'Succeeded' && phase !== 'Failed'
}

/**
 * A pod whose containers have stopped: it is still an object, and nothing in
 * it is executing any more.
 *
 * NOT the negation of {@link isPodLive}, and the gap between the two is the
 * whole point. A terminating pod — `deletionTimestamp` set, phase still
 * `Running` — is not live (never bind to it: its uid is about to stop being
 * a valid token) and not stopped either (its process is still running, and on
 * a workspace it is still writing to the caller's block device until it exits
 * or `terminationGracePeriodSeconds` runs out). A suspend that treated the
 * timestamp as "gone" would resolve mid-drain and promise a quiesced disk it
 * had not waited for.
 */
export function isPodStopped(pod: PodResource | undefined): boolean {
	const phase = pod?.status?.phase
	return phase === 'Succeeded' || phase === 'Failed'
}

/**
 * Backend-owned pod label naming which `SandboxTemplate` a Sandbox's pod was
 * built from.
 *
 * agent-sandbox's OWN template-adoption controller selects pods by a
 * controller-owned label, `agents.x-k8s.io/sandbox-template-ref-hash` — but
 * that label is written only onto a Sandbox ADOPTED out of a
 * `SandboxWarmPool` (the controller re-parents ownership and re-labels on
 * bind). A Sandbox this backend POSTs directly (the pool-less path in
 * `index.ts`'s `buildSandboxBody`) is never adopted, so it never gets that
 * label — a direct Sandbox's pod would carry nothing a `NetworkPolicy`
 * could reliably select it by. This backend writes its own label instead, on
 * every Sandbox it creates, pooled or direct, so `egress-policy.ts`'s
 * translated `NetworkPolicy` has one selector that always matches.
 *
 * `namzu.ai` matches the published domain (`packages/cli/package.json`'s
 * `homepage`); there is no pre-existing Kubernetes label or annotation
 * prefix anywhere in this repo to follow instead — the closest existing
 * convention, `NAMZU_AGENT_*` / `NAMZU_SANDBOX_*` env vars, is not a
 * label-safe shape.
 *
 * W8's `SandboxTemplate` manifests MUST set this same label (value = the
 * template's own name) on their `podTemplate.metadata.labels`, so a POOLED
 * sandbox's pod carries it too — the pool's pods are built from that
 * template's `podTemplate` directly, not through `buildSandboxBody`, so
 * nothing here can put it there for them. Skipping that step means a
 * translated `NetworkPolicy`'s `podSelector` matches only sandboxes this
 * backend created directly and none of the pooled ones — see
 * `docs/sdk/kubernetes-sandbox.md`'s egress section.
 */
export const SANDBOX_TEMPLATE_LABEL_KEY = 'sandbox.namzu.ai/template'

/**
 * Backend-owned annotation naming when a Sandbox's `spec.operatingMode` was
 * last changed BY THIS BACKEND, RFC 3339.
 *
 * It exists because nothing already on the object answers the question, and
 * an inventory that never wakes a workspace is the reason to ask it: a
 * retention pass deleting the workspaces nobody has resumed for a month reads
 * this and `metadata.creationTimestamp` and nothing else.
 *
 * The obvious candidate is the controller's own `Suspended` condition and its
 * `lastTransitionTime`, and upstream's `sandbox_types.go` rules it out in the
 * same breath it documents it: "the controller does not currently remove this
 * condition when the Sandbox is resumed", so after a resume the condition is
 * still True and its timestamp still names the suspend that preceded it. The
 * `Ready` condition's timestamp is no better — it moves for every pod that
 * comes and goes, a crash-restart included, and a workspace whose pod
 * restarted has not changed operating mode at all.
 *
 * So the two patches that DO change the mode stamp the moment they were sent,
 * and the value is exactly that: the host's clock at the moment it asked, not
 * the cluster's at the moment it applied. It is an inventory column, never a
 * lock or an ordering, and nothing in this backend reads it back to make a
 * decision. A Sandbox whose mode has never been changed since it was created
 * carries no annotation at all, and is reported without one rather than with
 * a guess.
 *
 * Same prefix as {@link SANDBOX_TEMPLATE_LABEL_KEY}, for the same reason.
 */
export const OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY = 'sandbox.namzu.ai/operating-mode-changed-at'

/** `{ [SANDBOX_TEMPLATE_LABEL_KEY]: sandboxTemplateName }`, as a matchLabels-ready object. */
export function sandboxTemplateLabel(
	sandboxTemplateName: string,
): Readonly<Record<string, string>> {
	return { [SANDBOX_TEMPLATE_LABEL_KEY]: sandboxTemplateName }
}

/** Core `NetworkPolicy` — a stock resource, no CRD. */
export const CORE_NETWORK_POLICY_API_GROUP = 'networking.k8s.io'
export const CORE_NETWORK_POLICY_API_VERSION = 'v1'

/**
 * Cilium's FQDN-capable policy CRD. Only reached when
 * `KubernetesEgressConfig.engine` is explicitly `'cilium'` — see
 * `egress-policy.ts`.
 */
export const CILIUM_NETWORK_POLICY_API_GROUP = 'cilium.io'
export const CILIUM_NETWORK_POLICY_API_VERSION = 'v2'

function segment(value: string): string {
	return encodeURIComponent(value)
}

export function claimCollectionPath(namespace: string): string {
	return `/apis/${SANDBOX_EXTENSIONS_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${segment(namespace)}/sandboxclaims`
}

export function claimPath(namespace: string, name: string): string {
	return `${claimCollectionPath(namespace)}/${segment(name)}`
}

export function sandboxCollectionPath(namespace: string): string {
	return `/apis/${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${segment(namespace)}/sandboxes`
}

export function sandboxPath(namespace: string, name: string): string {
	return `${sandboxCollectionPath(namespace)}/${segment(name)}`
}

export function sandboxTemplatePath(namespace: string, name: string): string {
	return `/apis/${SANDBOX_EXTENSIONS_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${segment(namespace)}/sandboxtemplates/${segment(name)}`
}

export function podPath(namespace: string, name: string): string {
	return `/api/v1/namespaces/${segment(namespace)}/pods/${segment(name)}`
}

export function podListPath(namespace: string, labelSelector: string): string {
	return `/api/v1/namespaces/${segment(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
}

export function networkPolicyPath(namespace: string, name: string): string {
	return `/apis/${CORE_NETWORK_POLICY_API_GROUP}/${CORE_NETWORK_POLICY_API_VERSION}/namespaces/${segment(namespace)}/networkpolicies/${segment(name)}`
}

export function ciliumNetworkPolicyPath(namespace: string, name: string): string {
	return `/apis/${CILIUM_NETWORK_POLICY_API_GROUP}/${CILIUM_NETWORK_POLICY_API_VERSION}/namespaces/${segment(namespace)}/ciliumnetworkpolicies/${segment(name)}`
}
