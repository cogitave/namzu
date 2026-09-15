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

export interface KubernetesObjectMeta {
	readonly name?: string
	readonly namespace?: string
	readonly uid?: string
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

export interface SandboxResourceSpec {
	readonly operatingMode?: 'Running' | 'Suspended'
	readonly podTemplate: SandboxPodTemplate
	/** Create a headless Service, and with it a `status.serviceFQDN`. */
	readonly service?: boolean
	readonly shutdownPolicy?: 'Delete' | 'Retain'
	/** RFC 3339, top-level on v1beta1 Sandbox (NOT under `lifecycle`). */
	readonly shutdownTime?: string
	readonly volumeClaimTemplates?: readonly Readonly<Record<string, unknown>>[]
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

export interface SandboxTemplateResource {
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: {
		readonly podTemplate?: SandboxPodTemplate
		readonly service?: boolean
		readonly volumeClaimTemplates?: readonly Readonly<Record<string, unknown>>[]
	}
}

/** Only `metadata.uid` is read — it is the per-instance agent bind token. */
export interface PodResource {
	readonly metadata?: KubernetesObjectMeta
}

export interface PodListResource {
	readonly items?: readonly PodResource[]
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
