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

import { createHash } from 'node:crypto'

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
	 * The object's version as this read saw it, written by the API server on
	 * every write and never by a client.
	 *
	 * It is here for exactly one use and no other: the fallback `test` clause
	 * of a holder-epoch patch aimed at an object that does not carry the
	 * annotation yet, and the `preconditions.resourceVersion` of a fenced
	 * DELETE — both INSIDE the one read-write pair that read it. It is never
	 * stored on a handle, never carried across calls and never streamed, so
	 * the "no watch, no informers, no resourceVersion tracking" invariant
	 * `k8s-client.ts` states still holds. See {@link buildHolderEpochPatch}.
	 */
	readonly resourceVersion?: string
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
 *
 * `additionalPodMetadata` is the exception, and the reason the rule above is
 * about COLD STARTS rather than about claim-time metadata in general: labels
 * are merged into an adopted warm sandbox without one. Measured on
 * agent-sandbox v1.0.2 — two claims out of one two-replica pool, each
 * carrying a different label value, both binding a replica that already
 * existed, and the controller patching the label onto the running pod and
 * into the Sandbox's own podTemplate. See `egress-policy.ts`'s profile
 * support.
 */
export interface SandboxClaimResourceSpec {
	readonly warmPoolRef: { readonly name: string }
	readonly lifecycle?: SandboxClaimLifecycle
	/**
	 * Labels (and annotations, which this backend never sets) the controller
	 * merges onto the pod it binds. Warm-safe — see the type comment.
	 */
	readonly additionalPodMetadata?: {
		readonly labels?: Readonly<Record<string, string>>
	}
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
 * A `GET` of the claims COLLECTION. Read by `readKubernetesTaskCapacity` (a
 * count) and `releaseKubernetesTaskSandboxes` (the names to `DELETE`) — both
 * in `index.ts`. Same "no watch, no `continue`" shape as
 * {@link SandboxListResource}, for the same reason: this backend does no
 * watch at all.
 */
export interface SandboxClaimListResource {
	readonly items?: readonly SandboxClaimResource[]
}

/**
 * `SandboxWarmPool.spec`/`.status`, read by `readKubernetesTaskCapacity`
 * alone — the first place in this backend that reads a `SandboxWarmPool`
 * rather than only naming one in a claim's `warmPoolRef`. Partial in the
 * same way every other shape here is: `replicas` and `readyReplicas` are the
 * two fields a capacity read needs, off the exact same object
 * `k8s/scripts/acquire-p50.mjs` already polls by hand.
 */
export interface SandboxWarmPoolResource {
	readonly metadata?: KubernetesObjectMeta
	readonly spec?: {
		readonly replicas?: number
	}
	readonly status?: {
		readonly readyReplicas?: number
	}
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
		/**
		 * `status.conditions` — read on ONE path only, and never on a healthy
		 * one: after an acquire has already run out of readiness budget,
		 * `PodScheduled=False` with reason `Unschedulable` is what separates
		 * "the cluster has no room" from "the sandbox is just slow". Nothing
		 * waits on a pod condition: `Ready` here is the kubelet's view of the
		 * container, and readiness on this backend is the Sandbox's own
		 * `Ready`, which is what {@link isConditionTrue} is called with
		 * everywhere else. See `index.ts`'s `diagnoseUnreadyPod`.
		 */
		readonly conditions?: readonly KubernetesCondition[]
		/**
		 * `status.containerStatuses` — read on the same one path, for the same
		 * one question. A container stuck in `waiting` with an image-pull
		 * reason is a permanent failure wearing the clothes of a slow start,
		 * and it is the only one of those this backend can name from the API.
		 */
		readonly containerStatuses?: readonly PodContainerStatus[]
	}
}

/** The single `status.containerStatuses` field the diagnosis above reads. */
export interface PodContainerStatus {
	readonly name?: string
	readonly state?: {
		readonly waiting?: { readonly reason?: string; readonly message?: string }
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

/**
 * Backend-owned annotation carrying the HOLDER EPOCH: a decimal integer the
 * host raises whenever authority over this workspace moves to another
 * process.
 *
 * A workspace id is a name, not a lock, and a host that drives one workspace
 * from more than one process has to decide which of them may suspend, resume
 * or delete it. Checking its own epoch and then calling `suspend()` does not
 * close the race, because the write that follows is a separate request and
 * the API server accepts it. So the epoch is stored HERE, on the object every
 * lifecycle write targets, and every such write carries it as a condition in
 * the same request — see {@link buildHolderEpochPatch}.
 *
 * The rule: a write carrying epoch `e` applies when the stored epoch is `<=
 * e`, and sets the stored epoch to `e` in the same request. A stored epoch
 * greater than `e` refuses it. An object with NO annotation reads as 0, so
 * every workspace created before this existed accepts its first
 * epoch-carrying write.
 *
 * It is the caller's number, never this backend's: nothing here invents,
 * increments or persists an epoch of its own, and a call that passes none
 * sends exactly the requests it always sent.
 *
 * Same prefix as {@link SANDBOX_TEMPLATE_LABEL_KEY} and
 * {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY}, for the same reason.
 */
export const HOLDER_EPOCH_ANNOTATION_KEY = 'sandbox.namzu.ai/holder-epoch'

/**
 * Backend-owned annotation carrying a hash of the pod template a Sandbox was
 * last built with.
 *
 * A Sandbox's `spec.podTemplate` is a COPY of the SandboxTemplate's, taken
 * once, and the controller rebuilds every replacement pod from that copy
 * rather than from the template — so a workspace kept for weeks runs the pod
 * spec it was created with, and an edit to the template (a new image tag, a
 * memory limit, a grace period, an env entry) reaches only workspaces created
 * after it. Nothing on the object answers "is this copy still the template's
 * current one": the two are separate objects with separate
 * `resourceVersion`s, and comparing the templates field by field on every
 * open would be a second, weaker copy of the overlay rules.
 *
 * So the value is a hash of exactly what was written: the template's
 * `podTemplate` AFTER this backend's own overlays (the template label and the
 * configured `runtimeClassName`), which is the object the Sandbox carries.
 * Hashing before the overlays would report drift on every workspace whose
 * RuntimeClass this backend chose.
 *
 * Written by the workspace paths only — the create POST and the refresh patch
 * — and read back as `templateRevision` on a handle. A task sandbox is
 * ephemeral and has nothing to drift from, so its create body is unchanged.
 * A workspace created before this existed carries no annotation and reports
 * `templateRevision: undefined`, which reads honestly as "unknown", never as
 * "current".
 *
 * Same prefix as {@link SANDBOX_TEMPLATE_LABEL_KEY}, for the same reason.
 */
export const POD_TEMPLATE_HASH_ANNOTATION_KEY = 'sandbox.namzu.ai/pod-template-hash'

/** Object keys in code-unit order, so the hash does not depend on a locale. */
function compareKeys(left: string, right: string): number {
	if (left < right) return -1
	return left > right ? 1 : 0
}

/**
 * The same JSON with its object keys sorted, recursively.
 *
 * `JSON.stringify` preserves insertion order, and the two pod templates this
 * hash has to compare never have the same one: one comes back from the API
 * server's own serialisation of a stored object and the other is built here
 * by spreading a template's members into a fresh object. Without this, every
 * comparison would report drift that does not exist.
 */
function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson)
	if (typeof value !== 'object' || value === null) return value
	const canonical: Record<string, unknown> = {}
	for (const key of Object.keys(value as Record<string, unknown>).sort(compareKeys)) {
		const member = (value as Record<string, unknown>)[key]
		if (member === undefined) continue
		canonical[key] = canonicalJson(member)
	}
	return canonical
}

/**
 * `sha256:<hex>` over the pod template, for
 * {@link POD_TEMPLATE_HASH_ANNOTATION_KEY}.
 *
 * It is an identity, not a checksum of anything security-relevant: two hosts
 * running the same release against the same template must compute the same
 * string, and a template edit must change it. Nothing here compares it
 * against a value an untrusted party chose.
 */
export function podTemplateHash(podTemplate: SandboxPodTemplate): string {
	const digest = createHash('sha256')
		.update(JSON.stringify(canonicalJson(podTemplate)))
		.digest('hex')
	return `sha256:${digest}`
}

/**
 * One RFC 6902 operation, in the only three shapes this backend sends.
 *
 * `test` is the condition, `add` is every mutation. `add` rather than
 * `replace` throughout: RFC 6902 §4.1 says that on a JSON object member `add`
 * creates the member when it is missing and replaces its value when it is
 * present, while §4.3's `replace` fails outright on a missing one — and
 * `spec.operatingMode` is absent on a Sandbox that has never been suspended,
 * as is the epoch annotation on every workspace created before this release.
 * A `replace` would turn both of those ordinary cases into a rejected patch.
 *
 * So where a design or an issue says the wire carries `replace /spec/…`, this
 * is that write: on a member that is already there the two operations are the
 * same write, and on one that is not, only this one lands.
 */
export interface JsonPatchOperation {
	readonly op: 'test' | 'add'
	readonly path: string
	readonly value: unknown
}

/**
 * One JSON Pointer reference token (RFC 6901 §3): `~` becomes `~0` and `/`
 * becomes `~1`, in that order — the reverse order would turn a literal `~1`
 * into a slash.
 *
 * An annotation key always contains a `/` (`sandbox.namzu.ai/holder-epoch`),
 * so the pointer to one is unusable without this.
 */
export function escapeJsonPointerSegment(token: string): string {
	return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Pointer to one annotation on an object's own metadata. */
export function annotationPointer(key: string): string {
	return `/metadata/annotations/${escapeJsonPointerSegment(key)}`
}

/** What one read of an object saw about its holder epoch. */
export interface HolderEpochReading {
	/**
	 * The stored epoch: the annotation parsed, or `0` when there is none.
	 *
	 * `undefined` means the annotation is PRESENT and is not a decimal
	 * integer, which no version of this backend writes. It is reported as
	 * unreadable rather than as 0 on purpose: reading a value this code does
	 * not understand as "nobody holds this workspace" would let a write
	 * overwrite a fence somebody else established, which is the one thing the
	 * annotation exists to prevent.
	 */
	readonly epoch?: number
	/**
	 * The annotation exactly as stored, and the value the `test` clause
	 * carries. Absent when the object has no such annotation.
	 */
	readonly annotation?: string
	/** `metadata.annotations` existed at all — decides which `add` is sent. */
	readonly hasAnnotations: boolean
	/** `metadata.resourceVersion`, for the fallback `test` and a fenced DELETE. */
	readonly resourceVersion?: string
}

/** Decimal, no sign, no padding, no exponent — what this backend writes. */
const HOLDER_EPOCH_PATTERN = /^(?:0|[1-9][0-9]*)$/

/** Read {@link HOLDER_EPOCH_ANNOTATION_KEY} off an object's metadata. */
export function readHolderEpoch(meta: KubernetesObjectMeta | undefined): HolderEpochReading {
	const annotations = meta?.annotations
	const resourceVersion =
		typeof meta?.resourceVersion === 'string' && meta.resourceVersion !== ''
			? meta.resourceVersion
			: undefined
	const stored = annotations?.[HOLDER_EPOCH_ANNOTATION_KEY]
	const base = {
		hasAnnotations: annotations !== undefined,
		...(resourceVersion !== undefined ? { resourceVersion } : {}),
	}
	if (typeof stored !== 'string') return { ...base, epoch: 0 }
	if (!HOLDER_EPOCH_PATTERN.test(stored)) return { ...base, annotation: stored }
	const parsed = Number(stored)
	if (!Number.isSafeInteger(parsed)) return { ...base, annotation: stored }
	return { ...base, epoch: parsed, annotation: stored }
}

/**
 * Read {@link POD_TEMPLATE_HASH_ANNOTATION_KEY} off an object's metadata.
 *
 * Absent — an object created before this existed, or one an older release
 * refreshed — is `undefined`, which reads as "unknown" everywhere it is
 * consumed. It is deliberately never compared as an empty string: a
 * revision nobody recorded is not a revision that differs.
 */
export function readPodTemplateHash(meta: KubernetesObjectMeta | undefined): string | undefined {
	const stored = meta?.annotations?.[POD_TEMPLATE_HASH_ANNOTATION_KEY]
	return typeof stored === 'string' && stored !== '' ? stored : undefined
}

/** A stored epoch of `epoch` or lower lets a write carrying `epoch` through. */
export function holderEpochAllows(reading: HolderEpochReading, epoch: number): boolean {
	return reading.epoch !== undefined && reading.epoch <= epoch
}

/** What {@link buildHolderEpochPatch} is asked to write, and under what condition. */
export interface HolderEpochPatchInput {
	/** The metadata the GET returned. The condition is built from THIS read. */
	readonly reading: HolderEpochReading
	/**
	 * The epoch the write carries, and the one it stores.
	 *
	 * ABSENT is the unfenced conditional write: no epoch clause is tested and
	 * no epoch annotation is written, and {@link tests} then carries the whole
	 * condition — which is why an epoch-less call with no `tests` is refused
	 * below rather than sent unconditionally. A workspace refresh is the one
	 * caller: its condition is `spec.operatingMode`, and a host that has not
	 * opted into the fence must not acquire one by asking for a new pod
	 * template.
	 */
	readonly epoch?: number
	/**
	 * Further `test` clauses composed into the SAME body.
	 *
	 * This is the seam a second condition uses instead of a second request: a
	 * write that also has to assert, say, `spec.operatingMode` passes its
	 * clause here and the object is still written under one atomic patch. Two
	 * call sites each sending their own conditional patch would be two writes
	 * and two chances to lose a race between them.
	 */
	readonly tests?: readonly JsonPatchOperation[]
	/** Written to `spec.operatingMode`; omitted leaves the mode alone. */
	readonly operatingMode?: 'Running' | 'Suspended'
	/**
	 * RFC 3339 stamp for {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY}.
	 * Passed only by a write that actually CHANGES the mode — the annotation
	 * says when the mode last changed, and a write that merely restamps the
	 * epoch has not changed it.
	 */
	readonly operatingModeChangedAt?: string
	/**
	 * Further annotations written in the SAME body, merged with the epoch's
	 * and the mode stamp's rather than sent after them.
	 *
	 * {@link POD_TEMPLATE_HASH_ANNOTATION_KEY} is the only caller: the hash
	 * has to land with the pod template it describes, or a patch that applied
	 * half of the pair would leave the object claiming a revision it is not
	 * running.
	 */
	readonly annotations?: Readonly<Record<string, string>>
	/**
	 * Written to `spec.podTemplate`, replacing it WHOLE — which is the reason
	 * this is a JSON Patch at all. A merge patch recurses into maps, so a
	 * `nodeSelector` entry the template dropped would survive in the object
	 * and the pod would keep a constraint nobody can see in the template any
	 * more.
	 */
	readonly podTemplate?: SandboxPodTemplate
}

/**
 * The one conditional-write builder this backend has, and the only place a
 * JSON Patch body is composed.
 *
 * Every clause is decided from ONE read, and the whole thing goes up as one
 * request: the condition and the mutation are in the same body, so there is
 * no window between checking and writing for another holder to fit into.
 *
 * Three shapes, decided by what that read saw:
 *
 *  - the object carries the epoch annotation ⇒ `test` it by its exact stored
 *    string, then `add` the new value over it;
 *  - the object carries annotations but not this one ⇒ `test`
 *    `/metadata/resourceVersion` instead, then `add` the member;
 *  - the object carries no `metadata.annotations` at all ⇒ the same
 *    `resourceVersion` test, then `add` the map whole, because there is no
 *    member to add one to.
 *
 * The `resourceVersion` fallback is the migration case and nothing more: it
 * fires once, on a workspace created before this release, and from the first
 * epoch write onwards the annotation is what is tested. That matters because
 * a controller status write moves `resourceVersion` without touching the
 * annotation, and under the annotation test those are simply not conditions
 * this write is interested in.
 *
 * A call carrying NO epoch skips all three: it tests only what
 * {@link HolderEpochPatchInput.tests} carries and writes no epoch annotation,
 * which is how a workspace refresh conditions itself on `spec.operatingMode`
 * without fencing a host that never asked for a fence.
 *
 * Every `test` precedes every mutation, which RFC 6902 requires of a
 * condition: operations apply in order, so a `test` written after an `add`
 * would be testing this patch's own work. Mutations go up in a fixed order —
 * annotations, then `spec.podTemplate`, then `spec.operatingMode` — so the
 * body a given input produces is one body and a test can assert it.
 */
export function buildHolderEpochPatch(input: HolderEpochPatchInput): readonly JsonPatchOperation[] {
	const { reading, epoch } = input
	const epochPointer = annotationPointer(HOLDER_EPOCH_ANNOTATION_KEY)
	const tests: JsonPatchOperation[] = []
	if (epoch === undefined) {
		// Unfenced: the caller's own clauses are the whole condition, and an
		// unconditional JSON patch is refused rather than sent. Every caller
		// on this branch is conditioning on something — a refresh on
		// `spec.operatingMode` — and one that passed nothing would be asking
		// for a blind write in the one builder that exists to prevent them.
		if ((input.tests ?? []).length === 0) {
			throw new Error(
				'kubernetes: cannot build a conditional patch that carries neither a holder epoch nor a test clause — there is nothing to condition the write on.',
			)
		}
	} else if (reading.annotation !== undefined) {
		tests.push({ op: 'test', path: epochPointer, value: reading.annotation })
	} else if (reading.resourceVersion !== undefined) {
		tests.push({ op: 'test', path: '/metadata/resourceVersion', value: reading.resourceVersion })
	} else {
		// Unreachable from every call site here — each one builds from an
		// object it just read, and the API server sets `resourceVersion` on
		// every object it serves. It throws rather than sending an
		// UNCONDITIONAL patch, because a fenced write that quietly stopped
		// being fenced is the defect this whole path exists to prevent.
		throw new Error(
			'kubernetes: cannot build a holder-epoch patch from an object that carries neither the holder-epoch annotation nor a metadata.resourceVersion — there is nothing to condition the write on.',
		)
	}
	tests.push(...(input.tests ?? []))

	const mutations: JsonPatchOperation[] = []
	// Every annotation this body writes, in one place: the epoch when the
	// write is fenced, the mode stamp when the mode moves, and whatever else
	// the caller is landing atomically with them.
	const annotations: Record<string, string> = {
		...(epoch !== undefined ? { [HOLDER_EPOCH_ANNOTATION_KEY]: String(epoch) } : {}),
		...(input.operatingModeChangedAt !== undefined
			? { [OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY]: input.operatingModeChangedAt }
			: {}),
		...input.annotations,
	}
	const keys = Object.keys(annotations)
	if (keys.length > 0) {
		if (!reading.hasAnnotations) {
			// No member to add one to, so the map goes up whole — and a whole
			// map REPLACES whatever is there, so this one operation is the only
			// mutation in this builder that can erase another writer's work.
			// The window is real: between the GET that saw no annotations and
			// this patch, another process can stamp one without moving
			// `spec.operatingMode` — a suspend carrying a holder epoch onto an
			// already-Suspended object does exactly that — and an unconditional
			// whole-map `add` would silently unfence the workspace it took.
			// `resourceVersion` is what closes it. The fenced path already
			// tests it on this branch (an object with no annotations has no
			// epoch annotation to test); this adds the same clause for an
			// UNFENCED caller, whose own clauses are about `spec` and say
			// nothing about `metadata`.
			if (!tests.some((test) => test.path === '/metadata/resourceVersion')) {
				if (reading.resourceVersion === undefined) {
					throw new Error(
						'kubernetes: cannot add a metadata.annotations map to an object that carries no metadata.resourceVersion — a whole-map write with nothing to condition it on would overwrite annotations written since the read.',
					)
				}
				tests.push({
					op: 'test',
					path: '/metadata/resourceVersion',
					value: reading.resourceVersion,
				})
			}
			mutations.push({ op: 'add', path: '/metadata/annotations', value: annotations })
		} else {
			for (const key of keys) {
				mutations.push({ op: 'add', path: annotationPointer(key), value: annotations[key] })
			}
		}
	}
	if (input.podTemplate !== undefined) {
		mutations.push({ op: 'add', path: '/spec/podTemplate', value: input.podTemplate })
	}
	if (input.operatingMode !== undefined) {
		mutations.push({ op: 'add', path: '/spec/operatingMode', value: input.operatingMode })
	}
	return [...tests, ...mutations]
}

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

/** The claims collection, narrowed to a `labelSelector` — same shape as {@link podListPath}. */
export function claimListPath(namespace: string, labelSelector: string): string {
	return `${claimCollectionPath(namespace)}?labelSelector=${encodeURIComponent(labelSelector)}`
}

export function warmPoolPath(namespace: string, name: string): string {
	return `/apis/${SANDBOX_EXTENSIONS_API_GROUP}/${SANDBOX_API_VERSION}/namespaces/${segment(namespace)}/sandboxwarmpools/${segment(name)}`
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

/**
 * The PVC the controller creates for one `volumeClaimTemplates` entry:
 * `<entry name>-<sandbox name>`, in the Sandbox's own namespace.
 *
 * Written out here rather than derived at each call site because it is a
 * NAME the controller owns, not one this backend chooses — a release that
 * changes it breaks every read of it at once, and the one place to notice
 * that is a function whose whole body is the convention.
 */
export function persistentVolumeClaimPath(
	namespace: string,
	sandboxName: string,
	claimTemplateName: string,
): string {
	return `/api/v1/namespaces/${segment(namespace)}/persistentvolumeclaims/${segment(
		`${claimTemplateName}-${sandboxName}`,
	)}`
}

export function podPath(namespace: string, name: string): string {
	return `/api/v1/namespaces/${segment(namespace)}/pods/${segment(name)}`
}

/** The whole pods collection, unfiltered. Read by `readKubernetesTaskCapacity` alone. */
export function podCollectionPath(namespace: string): string {
	return `/api/v1/namespaces/${segment(namespace)}/pods`
}

export function podListPath(namespace: string, labelSelector: string): string {
	return `/api/v1/namespaces/${segment(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
}

export function networkPolicyCollectionPath(namespace: string): string {
	return `/apis/${CORE_NETWORK_POLICY_API_GROUP}/${CORE_NETWORK_POLICY_API_VERSION}/namespaces/${segment(namespace)}/networkpolicies`
}

export function networkPolicyPath(namespace: string, name: string): string {
	return `${networkPolicyCollectionPath(namespace)}/${segment(name)}`
}

export function ciliumNetworkPolicyCollectionPath(namespace: string): string {
	return `/apis/${CILIUM_NETWORK_POLICY_API_GROUP}/${CILIUM_NETWORK_POLICY_API_VERSION}/namespaces/${segment(namespace)}/ciliumnetworkpolicies`
}

export function ciliumNetworkPolicyPath(namespace: string, name: string): string {
	return `${ciliumNetworkPolicyCollectionPath(namespace)}/${segment(name)}`
}
