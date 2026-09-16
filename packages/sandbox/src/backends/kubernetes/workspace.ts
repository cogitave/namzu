/**
 * The persistent workspace: a Sandbox that keeps its disk across suspends.
 *
 * A task sandbox (`index.ts`) is claimed, used and deleted inside one run. A
 * workspace is the opposite object: it is created once, addressed by a name
 * the CALLER chooses, suspended when nobody is using it, resumed days later
 * with yesterday's dependency cache and git checkout still on its disk, and
 * deleted only when someone says so.
 *
 * ## Why this is a directly created Sandbox and never a claim
 *
 * `Sandbox.spec.volumeClaimTemplates` is CEL-immutable on the served CRD
 * ("volumeClaimTemplates is immutable"), and a `SandboxClaim` that carries
 * `spec.volumeClaimTemplates` is forced to cold-start instead of adopting a
 * warm pool sandbox. So the disk has to be in the spec at creation, and the
 * appealing middle road — claim a warm diskless sandbox and attach a disk to
 * it — is not expressible in this API at all. A workspace is therefore a
 * `Sandbox` POSTed directly, with a deterministic name, and the warm pool has
 * nothing to do with it.
 *
 * ## Block, not a filesystem
 *
 * The disk must be `volumeMode: Block`, consumed through the container's
 * `volumeDevices`, and this module REFUSES a template whose disk is anything
 * else. Under a VM-isolating RuntimeClass a `Filesystem` PVC reaches the guest
 * through a host/guest filesystem passthrough (virtio-fs), whose per-file
 * overhead lands squarely on the two things a workspace does all day: walking
 * a dependency tree and touching thousands of small files. Nothing FAILS; the
 * workspace is merely several times slower, and no functional test can see
 * that. A raw block device the guest formats and mounts itself is an ordinary
 * local filesystem inside the VM. See {@link KubernetesWorkspaceDiskError}.
 *
 * ## No lease
 *
 * Every task sandbox carries `shutdownTime` + `shutdownPolicy: Delete`, so a
 * host that dies mid-run costs the cluster one expiry rather than a leak, and
 * its handle renews that expiry for as long as it lives. A workspace carries
 * NEITHER. An expiry on a workspace is a timer that deletes a caller's files,
 * and a renewal loop makes losing them conditional on a host process staying
 * up — exactly backwards for an object whose whole purpose is to outlive the
 * host. A workspace is explicitly managed: it goes away when
 * `destroy({ deleteDisk: true })` says so, and not before.
 *
 * ## Suspend, resume, and what changes across one
 *
 * `suspend()` merge-PATCHes `spec.operatingMode: Suspended`; the controller
 * deletes only the Pod and reconciles PVCs unconditionally on every pass, so
 * the disk survives with the same UID. It then waits on the POD — not on the
 * Sandbox's `Suspended` condition, which upstream documents as lingering True
 * after a resume, and not merely on a `deletionTimestamp`, which appears
 * while the guest is still running. `resume()` PATCHes it back and waits
 * for a new pod — and a resumed pod keeps the sandbox's NAME while getting a
 * new uid and a new IP. Both matter: the uid is the agent's bind token, and
 * the IP is where the agent answers. So resume re-resolves the address, re-
 * reads the uid (skipping the outgoing pod, which is still listed under the
 * same name while it terminates) and rebuilds the transport. Nothing from
 * before the suspend is reused.
 *
 * Between the two, every call refuses with
 * {@link KubernetesWorkspaceSuspendedError} and issues no dial. A dial would
 * be worse than useless: the address still resolves — the Service outlives
 * the pod — so the call would hang until a connect timeout with nothing in
 * the failure naming the suspend.
 *
 * ## Adoption is checked against the object, not against the caller
 *
 * A create that collides with an existing object of the same name ADOPTS it,
 * because the deterministic name is only worth having if coming back is the
 * normal path. What is adopted is then checked against the configuration: the
 * block disk, the `sandbox.namzu.ai/template` pod label (the label an egress
 * NetworkPolicy selects by) and `runtimeClassName` (the VM boundary). A
 * standing object that disagrees with any of them is refused by name rather
 * than driven — see {@link KubernetesWorkspaceMismatchError}. What is NOT
 * checked, and cannot be from here, is whether somebody else is already using
 * it: two host processes can hold handles to one running workspace, and the
 * `destroy()` of either suspends the pod the other is executing in. A
 * workspace id is a name, not a lock.
 *
 * ## There is no delete-compute-keep-disk verb
 *
 * The API has `operatingMode` and it has DELETE. Nothing in between. So
 * `destroy()` with no options, or `deleteDisk: false`, SUSPENDS and leaves
 * the object standing; only `destroy({ deleteDisk: true })` DELETEs the
 * Sandbox, which cascades to the Pod, the Service and the PVC through
 * ownerReferences. The default is the non-destructive one because `destroy()`
 * is what a `finally` block calls, and a `finally` block must not be able to
 * erase a workspace nobody asked to erase.
 *
 * The same holds for the paths nobody asked for at all. A create or resume
 * that fails suspends the object and rethrows rather than cleaning it up (see
 * {@link createKubernetesWorkspace}), and a pod that stops being able to say
 * what happened to a command — the shared execution controller's unconfirmed
 * cancellation, which retires a task sandbox by DELETING it — is retired here
 * by that same suspend patch (see {@link retireSession}). Exactly one DELETE
 * is reachable from this module, and it is the one `deleteDisk: true` asks
 * for.
 *
 * ## A state is committed when the cluster confirms it, never before
 *
 * Both verbs are idempotent, and both are idempotent by EARLY-RETURNING on a
 * state. That makes the moment a state is written the whole correctness
 * question: a handle that marks itself `deleted` before its DELETE lands
 * answers every later `destroy()` from that mark, so a 500 is thrown once and
 * the Sandbox then stands on the cluster with nothing left that would remove
 * it. The same shape on `suspend()` leaves a pod running — and billing —
 * behind a handle that says it is suspended.
 *
 * So `suspended` is written after the patch lands AND the pod is observed
 * stopped, `deleted` after the DELETE resolves (or reports the object already
 * gone), and a request that fails leaves the state it found. Concurrency is
 * covered the other way round, by a single flight per verb: a second caller
 * arriving mid-transition awaits the one in progress instead of sending a
 * second request into the gap the deferred mark opens.
 */

import type {
	OpenTerminalOptions,
	Sandbox,
	SandboxDestroyOptions,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxStatus,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	TerminalSession,
} from '@namzu/sdk'

import { OperationDeadline, OperationDeadlineExpired, runFailureCleanup } from '../readiness.js'
import { assertEgressPolicyIsEnforceable } from './egress-policy.js'
import {
	DEFAULT_AGENT_PORT,
	type KubernetesBackendInternalConfig,
	type KubernetesSandboxBinding,
	bindingFromSandbox,
	buildSandboxBody,
	clientAccess,
	pollForBinding,
	probeSandboxPrivileges,
	readPodBindToken,
	readSandboxTemplate,
	resolveAgentAddress,
	resolveKubernetesReadiness,
	resolveProbeTimeoutMs,
	verifyEgressPolicyConfigured,
} from './index.js'
import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	KubernetesConflictError,
	createKubernetesClient,
} from './k8s-client.js'
import {
	type PodResource,
	SANDBOX_TEMPLATE_LABEL_KEY,
	type SandboxPodTemplate,
	type SandboxResource,
	type SandboxVolumeClaimTemplate,
	isPodStopped,
	podPath,
	sandboxCollectionPath,
	sandboxPath,
} from './objects.js'
import {
	KubernetesSandboxDestroyedError,
	type KubernetesSandboxHandle,
	buildKubernetesSandbox,
} from './sandbox.js'
import { KubernetesAgentTransport } from './transport.js'

/**
 * Thrown when a workspace's `SandboxTemplate` does not describe a block disk
 * this backend is willing to build a workspace on.
 *
 * Named, and thrown before anything is created, because every shape it
 * refuses WORKS: a template with no disk produces a sandbox whose files
 * vanish on the next suspend, and a `Filesystem` disk produces one that keeps
 * its files and is quietly several times slower at the small-file IO a
 * workspace is made of. Neither fails a functional test, so neither can be
 * left to be noticed later.
 */
export class KubernetesWorkspaceDiskError extends Error {
	override readonly name = 'KubernetesWorkspaceDiskError'

	constructor(
		/** What was inspected — a `SandboxTemplate`, or an existing Sandbox. */
		readonly source: string,
		message: string,
	) {
		super(message)
	}
}

/**
 * Thrown when the Sandbox already standing under a workspace's name was not
 * built the way this caller is configured to build one.
 *
 * Adoption is the NORMAL path — the deterministic name exists so that coming
 * back to a workspace is cheap — and that is exactly why the object handed
 * back is checked against the configuration rather than against the caller's
 * intention. Two controls would otherwise be lost silently, and lost for as
 * long as the workspace lives, which is the longest of anything this backend
 * makes:
 *
 *  - the `sandbox.namzu.ai/template` pod label, which is what a translated
 *    egress `NetworkPolicy`'s `podSelector` matches. A pod carrying another
 *    value — or none — is not selected by the policy this call just verified,
 *    so the boundary would report verified while covering nothing.
 *  - `runtimeClassName`, which is the VM boundary. The privilege probe cannot
 *    stand in for it: `/proc/self/status` reads the same inside a VM guest as
 *    it does inside an ordinary shared-kernel container.
 *
 * Nothing is patched to make the standing object match. Its disk may hold a
 * month of the caller's files, and rewriting a live workspace's podTemplate to
 * fit a new configuration is a larger decision than reattaching to it.
 */
export class KubernetesWorkspaceMismatchError extends Error {
	override readonly name = 'KubernetesWorkspaceMismatchError'

	constructor(
		/** The Sandbox found standing under this workspace's name. */
		readonly sandboxName: string,
		/** Which configured field the standing object disagrees with. */
		readonly field: 'sandboxTemplateName' | 'runtimeClassName',
		/** What the configuration asked for. */
		readonly expected: string,
		/** What the object carries — absent when it carries nothing at all. */
		readonly actual: string | undefined,
		message: string,
	) {
		super(message)
	}
}

/**
 * Thrown by every operation on a workspace that is currently suspended.
 *
 * Distinct from {@link KubernetesSandboxDestroyedError} because the state is
 * RECOVERABLE and the advice is one word: call `resume()`. Nothing is dialed
 * before it is thrown.
 */
export class KubernetesWorkspaceSuspendedError extends Error {
	override readonly name = 'KubernetesWorkspaceSuspendedError'

	constructor(
		readonly operation: string,
		readonly workspaceId: string,
		readonly sandboxName: string,
	) {
		super(
			`kubernetes workspace ${workspaceId} (Sandbox ${sandboxName}) is suspended; ${operation}() cannot be admitted and nothing was dialed. Its pod is deleted and its disk is intact — call resume() to get a new pod, a new address and a new agent token, then retry.`,
		)
	}
}

/**
 * Thrown when a suspend's `operatingMode: Suspended` patch was accepted and
 * the pod had still not stopped by the readiness deadline.
 *
 * The workspace is left in the state that is TRUE rather than the one that
 * was asked for: the patch landed, so the pod is on its way out and no call
 * is admitted — but the suspend is not recorded as finished, because it did
 * not finish. A later `suspend()` sends the patch again and waits again
 * instead of returning on a mark this one left behind, and `resume()` still
 * works.
 *
 * Recording it as suspended here is exactly the defect this class exists to
 * make impossible. The guest is still running, still holding the block device
 * open and still writing to it, and "suspended" is a promise that the disk is
 * quiesced — so a handle that made that promise on a wait it lost would let
 * the next caller resume, or delete, a workspace mid-write.
 */
export class KubernetesWorkspaceSuspendTimeoutError extends Error {
	override readonly name = 'KubernetesWorkspaceSuspendTimeoutError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
		/** The readiness budget the wait was given, in milliseconds. */
		readonly timeoutMs: number,
	) {
		super(
			`kubernetes: workspace ${workspaceId} (Sandbox ${sandboxName}) was patched to operatingMode: Suspended but its pod had still not stopped ${timeoutMs}ms later, so the suspend is UNCONFIRMED and the disk cannot be promised quiesced. A guest whose PID 1 ignores SIGTERM rides out its terminationGracePeriodSeconds first; raise readyTimeoutMs, or make the image exit promptly on SIGTERM. Nothing was deleted and the disk is untouched: no call is admitted while the pod drains, suspend() sends the patch again and waits again, and resume() brings the workspace back.`,
		)
	}
}

/** Authority for one lifecycle transition, owned independently of the run. */
export interface KubernetesWorkspaceTransitionOptions {
	readonly signal?: AbortSignal
}

/**
 * `destroy()` on a workspace, with the one field that decides whether the
 * disk survives. See the module comment: the default keeps it.
 */
export interface KubernetesWorkspaceDestroyOptions extends SandboxDestroyOptions {
	/**
	 * `true` DELETEs the Sandbox, cascading to its Pod, Service and PVC —
	 * the caller's files are gone and nothing brings them back. Anything else,
	 * including the default, suspends and leaves the object standing.
	 */
	readonly deleteDisk?: boolean
}

/**
 * A {@link Sandbox} that survives having its compute taken away.
 *
 * Declared here rather than on the SDK's `Sandbox`: the brief frames these as
 * BACKEND capabilities, and keeping them out of `@namzu/sdk` means no new
 * `SandboxStatus` member, no optional `suspend?()`/`resume?()` on the shared
 * contract that every other backend would then have to answer for, and no
 * `deleteDisk` field on the shared `SandboxDestroyOptions`.
 */
export interface KubernetesWorkspace extends Sandbox {
	/**
	 * True from the moment `suspend()` starts until `resume()` finishes.
	 *
	 * `status` cannot say this — `SandboxStatus` has four members and none of
	 * them is "suspended" — so a suspended workspace reports `destroyed`,
	 * which is the only member that means "cannot serve a call". This flag is
	 * what tells the recoverable state from the final one without widening the
	 * SDK's union.
	 */
	readonly suspended: boolean
	openTerminal(options: OpenTerminalOptions): Promise<TerminalSession>
	openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection>
	/**
	 * Give the compute back and keep the disk. Idempotent: suspending a
	 * workspace whose suspend has been CONFIRMED sends nothing.
	 *
	 * Resolves once the POD has actually stopped, not merely once the patch
	 * was accepted and not on the Sandbox's `Suspended` condition, which
	 * upstream leaves standing after a resume — a guest that ignores SIGTERM
	 * rides out its `terminationGracePeriodSeconds` first, and it is writing
	 * to the disk for all of it.
	 *
	 * Rejects, leaving the workspace usable and unchanged, if the cluster
	 * refuses the patch; rejects with {@link KubernetesWorkspaceSuspendTimeoutError},
	 * admitting no call, if the patch landed and the pod outlived the wait.
	 * Either way the next `suspend()` sends the patch again rather than
	 * returning on this one's word. Concurrent calls share one transition.
	 *
	 * A call already in flight when this is called is not cancelled: it fails
	 * at the transport when the pod goes away, rather than with the named
	 * suspended error, which only covers calls admitted from here on.
	 */
	suspend(options?: KubernetesWorkspaceTransitionOptions): Promise<void>
	/**
	 * Take a new pod, on a new address, with a new agent token, and prove it
	 * is deprivileged before handing it back. Idempotent: resuming a running
	 * workspace sends nothing.
	 */
	resume(options?: KubernetesWorkspaceTransitionOptions): Promise<void>
	/**
	 * With no options, or `deleteDisk: false`, this SUSPENDS: the disk stays
	 * and so does the handle, which reports `status: 'destroyed'` and
	 * `suspended: true` and can still be `resume()`d. Only
	 * `deleteDisk: true` is final.
	 *
	 * A `deleteDisk: true` whose DELETE fails REJECTS and stays retryable —
	 * the workspace is not recorded as deleted on a request that did not
	 * land, because the early return on that record is what a retry would
	 * hit. Concurrent calls share one DELETE.
	 */
	destroy(options?: KubernetesWorkspaceDestroyOptions): Promise<void>
}

export interface KubernetesWorkspaceOptions {
	/**
	 * The caller's own stable name for this workspace. The Sandbox is named
	 * `namzu-ws-<workspaceId>`, deterministically, which is what makes a
	 * workspace reachable again from a different host process — see
	 * {@link workspaceSandboxName} for why the id is refused rather than
	 * sanitised.
	 */
	readonly workspaceId: string
	/** Reported as `rootDir`; where the guest's entrypoint mounted the disk. */
	readonly workingDirectory: string
	/**
	 * `SandboxTemplate` whose `podTemplate` AND `volumeClaimTemplates` this
	 * workspace is built from. Defaults to the backend's own
	 * `sandboxTemplateName`, but a deployment normally has two — a task
	 * template with no disk, and a workspace template with a block one.
	 */
	readonly sandboxTemplateName?: string
	readonly signal?: AbortSignal
}

/** Prefix every workspace Sandbox's name carries. */
export const WORKSPACE_NAME_PREFIX = 'namzu-ws-'

/** DNS-1123 label: the Sandbox's name is also its Pod's and its Service's. */
const DNS_LABEL_MAX_LENGTH = 63
const MAX_WORKSPACE_ID_LENGTH = DNS_LABEL_MAX_LENGTH - WORKSPACE_NAME_PREFIX.length
const WORKSPACE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * The Sandbox name for a workspace id.
 *
 * Deterministic on purpose: it is the only way a second host process, or the
 * same one tomorrow, finds the workspace again. Which is also why an id that
 * does not already fit a DNS-1123 label is REFUSED rather than lowercased,
 * stripped or hashed: sanitising maps two ids onto one name, and two callers
 * who believe they have separate workspaces would be sharing one disk.
 * Hashing would fit every id and make the name unreadable in `kubectl get
 * sandbox`, which is most of what the deterministic name is for.
 */
export function workspaceSandboxName(workspaceId: string): string {
	if (!WORKSPACE_ID_PATTERN.test(workspaceId) || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) {
		throw new Error(
			`kubernetes: workspace id ${JSON.stringify(workspaceId)} cannot name a Sandbox. It must be 1-${MAX_WORKSPACE_ID_LENGTH} characters of lowercase letters, digits and '-', starting and ending alphanumeric, so that ${WORKSPACE_NAME_PREFIX}<id> is a legal DNS-1123 label for the Sandbox, its Pod and its Service. The id is refused rather than sanitised because two ids that sanitise to one name would silently share one disk.`,
		)
	}
	return `${WORKSPACE_NAME_PREFIX}${workspaceId}`
}

function readArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : []
}

function readNames(container: unknown, field: 'volumeDevices' | 'volumeMounts'): string[] {
	if (typeof container !== 'object' || container === null) return []
	const entries = readArray((container as Record<string, unknown>)[field])
	const names: string[] = []
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) continue
		const name = (entry as { name?: unknown }).name
		if (typeof name === 'string' && name !== '') names.push(name)
	}
	return names
}

/**
 * Every name a pod template's containers claim through `volumeDevices` (a raw
 * block device) or `volumeMounts` (a filesystem), across both container lists.
 * The pod spec is carried opaquely everywhere else in this backend, so it is
 * read defensively here rather than typed: an unexpected shape contributes
 * nothing and lets the named refusal below do the talking.
 */
function readVolumeConsumers(podTemplate: SandboxPodTemplate | undefined): {
	devices: Set<string>
	mounts: Set<string>
} {
	const devices = new Set<string>()
	const mounts = new Set<string>()
	const spec = podTemplate?.spec
	for (const key of ['containers', 'initContainers'] as const) {
		for (const container of readArray(spec?.[key])) {
			for (const name of readNames(container, 'volumeDevices')) devices.add(name)
			for (const name of readNames(container, 'volumeMounts')) mounts.add(name)
		}
	}
	return { devices, mounts }
}

/**
 * Refuse anything that is not a block disk a container actually consumes as
 * one. Every branch here describes a configuration that would work and then
 * disappoint — see {@link KubernetesWorkspaceDiskError}.
 */
export function assertBlockModeWorkspaceDisk(
	source: string,
	podTemplate: SandboxPodTemplate | undefined,
	volumeClaimTemplates: readonly SandboxVolumeClaimTemplate[] | undefined,
): void {
	if (volumeClaimTemplates === undefined || volumeClaimTemplates.length === 0) {
		throw new KubernetesWorkspaceDiskError(
			source,
			`kubernetes: ${source} declares no spec.volumeClaimTemplates, so a workspace built from it would have no disk and would lose everything on its first suspend — that is a task sandbox, not a workspace. Add a volumeClaimTemplates entry with spec.volumeMode: Block and consume it from the container's volumeDevices.`,
		)
	}
	const { devices, mounts } = readVolumeConsumers(podTemplate)
	for (const entry of volumeClaimTemplates) {
		const name = entry.metadata?.name
		if (typeof name !== 'string' || name === '') {
			throw new KubernetesWorkspaceDiskError(
				source,
				`kubernetes: ${source} declares a spec.volumeClaimTemplates entry with no metadata.name. The controller wires the disk by that name, StatefulSet style — it creates the PVC as <entry name>-<sandbox name> and matches the container's volumeDevices entry against it — so an unnamed entry reaches no container at all.`,
			)
		}
		const volumeMode = entry.spec?.volumeMode
		if (volumeMode !== 'Block') {
			throw new KubernetesWorkspaceDiskError(
				source,
				`kubernetes: ${source} declares volumeClaimTemplate ${JSON.stringify(name)} with volumeMode ${JSON.stringify(volumeMode ?? 'Filesystem (the API default)')}, but a persistent workspace's disk must be volumeMode: Block. Under a VM-isolating RuntimeClass a Filesystem PVC reaches the guest over a host/guest filesystem passthrough (virtio-fs), which pays a round trip per file operation — a dependency tree walk or a git status over a large checkout is several times slower, while nothing fails and no functional test can see it. A Block volume is a raw device the guest formats once and mounts as an ordinary local filesystem. Set spec.volumeMode: Block on this entry and consume it through the container's volumeDevices.`,
			)
		}
		if (mounts.has(name)) {
			throw new KubernetesWorkspaceDiskError(
				source,
				`kubernetes: ${source} consumes the Block volumeClaimTemplate ${JSON.stringify(name)} through a container's volumeMounts. A raw block device is claimed through volumeDevices (which gives the container a device node at devicePath); volumeMounts is the filesystem form and the kubelet will refuse the pod. Move the entry to volumeDevices and let the image's entrypoint format and mount the device.`,
			)
		}
		if (!devices.has(name)) {
			throw new KubernetesWorkspaceDiskError(
				source,
				`kubernetes: ${source} declares the Block volumeClaimTemplate ${JSON.stringify(name)} but no container claims it through volumeDevices, so the PVC is provisioned and attached to nothing. Add a volumeDevices entry naming ${JSON.stringify(name)} with the devicePath the image's entrypoint formats and mounts.`,
			)
		}
	}
}

/**
 * Refuse a standing Sandbox that was built from another `SandboxTemplate`, or
 * that runs without the RuntimeClass this backend is configured for.
 *
 * Read off `spec.podTemplate` — the copy the controller actually runs a pod
 * from — rather than off anything this process decided, because the question
 * is what the POD is, not what the caller meant it to be.
 *
 * The template check is unconditional, `config.egress` set or not: the label
 * is also how an operator reads which template an object came from, and an
 * object whose label says one thing while the caller builds from another is a
 * mix-up worth naming the first time it is seen rather than the first time a
 * policy is switched on. See {@link KubernetesWorkspaceMismatchError}.
 */
export function assertAdoptedWorkspaceMatchesConfig(
	sandboxName: string,
	namespace: string,
	podTemplate: SandboxPodTemplate | undefined,
	expected: { readonly sandboxTemplateName: string; readonly runtimeClassName?: string },
): void {
	const label = podTemplate?.metadata?.labels?.[SANDBOX_TEMPLATE_LABEL_KEY]
	if (label !== expected.sandboxTemplateName) {
		throw new KubernetesWorkspaceMismatchError(
			sandboxName,
			'sandboxTemplateName',
			expected.sandboxTemplateName,
			label,
			`kubernetes: Sandbox ${sandboxName} in namespace ${namespace} already exists, and its spec.podTemplate carries ${SANDBOX_TEMPLATE_LABEL_KEY}: ${label === undefined ? '(absent)' : JSON.stringify(label)} rather than ${JSON.stringify(expected.sandboxTemplateName)} — it was built from a different SandboxTemplate, so it is not the workspace this call describes. That label is the one an egress NetworkPolicy's podSelector matches, so adopting this object would hand back a pod the policy verified for ${JSON.stringify(expected.sandboxTemplateName)} does not select, having reported the boundary as verified. Point this workspace at the template the object was built from, or delete the Sandbox — which takes its disk with it — and create it again, or choose another workspaceId.`,
		)
	}
	if (expected.runtimeClassName === undefined) return
	const declared = podTemplate?.spec?.runtimeClassName
	const actual = typeof declared === 'string' ? declared : undefined
	if (actual !== expected.runtimeClassName) {
		throw new KubernetesWorkspaceMismatchError(
			sandboxName,
			'runtimeClassName',
			expected.runtimeClassName,
			actual,
			`kubernetes: Sandbox ${sandboxName} in namespace ${namespace} already exists, and its spec.podTemplate.spec.runtimeClassName is ${actual === undefined ? "(absent — the cluster's default runtime)" : JSON.stringify(actual)} rather than the configured ${JSON.stringify(expected.runtimeClassName)}. Running it would put the workspace on that runtime — a shared kernel, if it is the default — while this backend registers itself as tier 'microvm', and nothing downstream would notice: the privilege probe reads /proc/self/status inside the guest and passes identically under a VM and under runc. A standing object's RuntimeClass is not something this backend rewrites underneath a disk it did not create, so the mismatch is named instead. Delete the Sandbox — which takes its disk with it — and create it again under ${JSON.stringify(expected.runtimeClassName)}, or drop runtimeClassName from the config if this object's runtime is the intended one.`,
		)
	}
}

/**
 * Where the workspace is, as far as the CLUSTER has CONFIRMED it.
 *
 *  - `running` — a pod is up and `session` serves calls.
 *  - `suspending` — the suspend patch landed, so the pod is going away and no
 *    call is admitted, but the pod has not been observed stopped yet. Also
 *    where a suspend that ran out of that wait leaves the workspace.
 *  - `suspended` — the patch landed AND the pod was observed stopped. Only
 *    this one is a state a second `suspend()` may return from without
 *    touching the cluster.
 *  - `deleted` — the DELETE landed. Terminal.
 *
 * Every state that an operation early-returns on is committed AFTER the
 * request that causes it resolves, never before. A state marked on the way
 * out turns a FAILED request into a silent success, because that early return
 * is what every later call reads: a destroy whose DELETE 500s would answer
 * "already deleted" forever while the object stood on the cluster, and a
 * suspend whose PATCH 500s would answer "already suspended" while the pod
 * kept running.
 */
type WorkspaceState = 'running' | 'suspending' | 'suspended' | 'deleted'

/**
 * Create the workspace, or take over the one that is already there.
 *
 * A second call with the same `workspaceId` ADOPTS rather than fails: the
 * POST comes back 409 Conflict, and the object it collided with is this
 * caller's own workspace from an earlier process. The deterministic name is
 * only useful if coming back to it is the normal path. An adopted object is
 * checked against the same block-disk rule a fresh one is, so a Sandbox
 * standing under this name that is not a workspace is refused rather than
 * used.
 *
 * Nothing here is ever deleted on failure. A create that gets as far as an
 * existing object and then fails — a readiness timeout, a privilege probe
 * refusal — SUSPENDS it and rethrows, because the object may be a workspace
 * with a disk full of the caller's files and `deleteDisk` is not a decision
 * a failure path gets to make. That holds even when THIS call POSTed the
 * object and its disk is therefore empty: the 409 above means two processes
 * can be coming up on one name at once, and the one that got the 201 deleting
 * its "own" fresh object would take the disk of the one that adopted it. The
 * cost is named rather than paid: a failed create can leave one suspended
 * Sandbox standing, which the caller finds again under the same deterministic
 * name and nothing reaps for them — see the docs page.
 */
export async function createKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceOptions,
): Promise<KubernetesWorkspace> {
	options.signal?.throwIfAborted()
	const readiness = resolveKubernetesReadiness(config)
	const namespace = config.namespace
	const name = workspaceSandboxName(options.workspaceId)
	const templateName = options.sandboxTemplateName ?? config.sandboxTemplateName
	const agentPort = config.agentPort ?? DEFAULT_AGENT_PORT
	const client = createKubernetesClient(clientAccess(config))

	// The same two egress steps `buildKubernetesBackend` runs for a task
	// sandbox, repeated here because a workspace never goes through it. The
	// refusal is synchronous and decided from the policy KIND alone; the
	// verification is a GET of the object an operator was supposed to apply,
	// and neither ever creates or repairs anything — see `egress-policy.ts`.
	//
	// Not optional on this path, and not a copy-paste: a long-lived workspace
	// is the sandbox most likely to be pointed at a network, the NetworkPolicy
	// rather than the bind token is the boundary on its agent port, and a
	// config object refused by one entry point and silently ignored by the
	// other is the exact silent downgrade this translation exists to prevent.
	//
	// Verified against the template this workspace is actually built from:
	// `buildSandboxBody` stamps the pod with THAT template's label and the
	// policy's podSelector matches that label, so a workspace built from a
	// separate workspace template needs its own policy — the task template's
	// does not select it. Deliberately not memoized the way the backend's
	// once-per-backend check is: creating a workspace is a rare, explicit act
	// with nothing to amortise, and re-checking costs one GET.
	if (config.egress) {
		assertEgressPolicyIsEnforceable(config.egress.policy, config.egress.engine ?? 'core')
		await verifyEgressPolicyConfigured(
			client,
			namespace,
			templateName,
			config.egress,
			options.signal,
		)
	}

	// Read and validate BEFORE anything is created, so a template that cannot
	// carry a workspace fails with nothing to clean up.
	const template = await readSandboxTemplate(client, namespace, templateName, options.signal)
	assertBlockModeWorkspaceDisk(
		`SandboxTemplate ${templateName} in namespace ${namespace}`,
		template.podTemplate,
		template.volumeClaimTemplates,
	)

	let created = false
	try {
		await client.request(
			'POST',
			sandboxCollectionPath(namespace),
			// No shutdownTime: a workspace carries no expiry — see the module
			// comment.
			buildSandboxBody({
				namespace,
				name,
				template,
				sandboxTemplateName: templateName,
				...(config.runtimeClassName !== undefined
					? { runtimeClassName: config.runtimeClassName }
					: {}),
			}),
			options.signal,
		)
		created = true
	} catch (err) {
		if (!(err instanceof KubernetesConflictError)) throw err
		await adoptExistingWorkspace(
			client,
			namespace,
			name,
			{
				sandboxTemplateName: templateName,
				...(config.runtimeClassName !== undefined
					? { runtimeClassName: config.runtimeClassName }
					: {}),
			},
			options.signal,
		)
	}

	return await openWorkspaceHandle({
		client,
		namespace,
		name,
		workspaceId: options.workspaceId,
		rootDir: options.workingDirectory,
		agentPort,
		readiness,
		created,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	})
}

/**
 * Take over a Sandbox that already stands under this workspace's name: check
 * that it really is a block-disk workspace AND that it is the one this
 * configuration describes, then wake it if it is asleep.
 *
 * Everything checked here is checked against the object, because on this path
 * the object is not the one this call built. A create POSTs its own body and
 * knows what is in it; an adopt is handed a pod somebody else's process, or
 * last month's configuration, decided the shape of. The two silent losses are
 * the template label and the RuntimeClass — see
 * {@link KubernetesWorkspaceMismatchError}.
 *
 * The refusals all happen BEFORE the resume patch: an object this call will
 * not use is not woken up on the way to being rejected.
 */
async function adoptExistingWorkspace(
	client: KubernetesClient,
	namespace: string,
	name: string,
	expected: { readonly sandboxTemplateName: string; readonly runtimeClassName?: string },
	signal?: AbortSignal,
): Promise<void> {
	const existing = await client.request<SandboxResource>(
		'GET',
		sandboxPath(namespace, name),
		undefined,
		signal,
	)
	assertBlockModeWorkspaceDisk(
		`Sandbox ${name} in namespace ${namespace}`,
		existing?.spec?.podTemplate,
		existing?.spec?.volumeClaimTemplates,
	)
	assertAdoptedWorkspaceMatchesConfig(name, namespace, existing?.spec?.podTemplate, expected)
	if (existing?.spec?.operatingMode === 'Suspended') {
		await client.request('PATCH', sandboxPath(namespace, name), RESUME_PATCH, signal)
	}
}

/** The two merge patches this module sends, and the only two. */
const SUSPEND_PATCH = { spec: { operatingMode: 'Suspended' } } as const
const RESUME_PATCH = { spec: { operatingMode: 'Running' } } as const

interface WorkspaceHandleOptions {
	readonly client: KubernetesClient
	readonly namespace: string
	readonly name: string
	readonly workspaceId: string
	readonly rootDir: string
	readonly agentPort: number
	readonly readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number }
	/** Whether THIS call POSTed the object, for the failure message only. */
	readonly created: boolean
	readonly signal?: AbortSignal
}

async function openWorkspaceHandle(options: WorkspaceHandleOptions): Promise<KubernetesWorkspace> {
	const { client, namespace, name, workspaceId, readiness } = options
	const id = name as SandboxId

	let state: WorkspaceState = 'running'
	let session: KubernetesSandboxHandle | undefined
	/**
	 * The uid of the pod `session` is bound to — the agent's token, and the
	 * only way a resume can tell the pod it is waiting for from the one it is
	 * replacing. Read once per session and never carried across one.
	 */
	let podUid: string | undefined
	/**
	 * The uid of the pod a suspend patch that LANDED took away, cleared once a
	 * resume has bound its replacement.
	 *
	 * This — not `podUid` — is what a resume excludes; see
	 * {@link acquireBoundPod}. It is set from the PATCH rather than from the
	 * wait that follows it, so a suspend whose pod outlived `readyTimeoutMs`
	 * excludes that pod too: the controller was asked to delete it either
	 * way, and a resume arriving while it drains is handed exactly that pod.
	 * Every path that sends that patch records it here: `suspend()`, the
	 * retirement of a pod that stopped answering, and the cleanup after a
	 * failed create or resume — which swallows its own failure, and so
	 * records only when the request actually came back. A pod nobody asked
	 * the controller to remove has no replacement to wait for, and excluding
	 * it would time out a resume whose workspace was perfectly usable.
	 */
	let retiredPodUid: string | undefined
	const terminals = new Set<TerminalSession>()

	/**
	 * Lifecycle transitions run one at a time. Two of them racing would
	 * interleave a suspend patch with a resume's readiness poll and settle on
	 * whichever finished last, which is how a workspace ends up marked running
	 * with no pod.
	 */
	let queue: Promise<unknown> = Promise.resolve()
	const serialise = <T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.then(run, run)
		queue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	/**
	 * The suspend and the delete currently in flight, so a second caller
	 * AWAITS the one that is running rather than queueing another behind it.
	 *
	 * Serialising is not the same thing and does not cover this. Now that a
	 * terminal state is committed only after its request lands, two
	 * concurrent `destroy({ deleteDisk: true })` calls would BOTH be admitted
	 * under the queue alone — the second finding nothing yet marked and
	 * sending a second DELETE — and two concurrent `suspend()` calls would
	 * patch and wait twice over. So the single-flight check sits OUTSIDE the
	 * queue, where a caller arriving mid-transition can still see it.
	 *
	 * The first caller's `signal` is the one the shared request runs under;
	 * a second caller's is not consulted, which is what sharing means.
	 */
	let pendingSuspend: Promise<void> | undefined
	let pendingDelete: Promise<void> | undefined

	const deleteSandbox = async (signal?: AbortSignal): Promise<void> => {
		try {
			await client.request('DELETE', sandboxPath(namespace, name), undefined, signal)
		} catch (err) {
			// Already gone is the state DELETE was asking for.
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
		}
	}

	const readBinding = async (
		pollSignal: AbortSignal,
	): Promise<KubernetesSandboxBinding | undefined> =>
		bindingFromSandbox(
			await client.request<SandboxResource>(
				'GET',
				sandboxPath(namespace, name),
				undefined,
				pollSignal,
			),
		)

	/**
	 * Wait until the Sandbox is Ready AND the pod behind it is a pod this
	 * handle is allowed to bind to, then read that pod's uid.
	 *
	 * On create there is nothing to exclude and this is one poll plus one
	 * read, exactly as it was. On RESUME `previousPodUid` is the pod the
	 * workspace was suspended from, and excluding it is the whole point:
	 * `Ready` is not a transition signal. The controller leaves the condition
	 * True across a resume — upstream says the same of `Suspended` in the
	 * other direction — so the very first poll after the Running patch can
	 * come back Ready while the only pod under that name is still the old
	 * one, not yet deleted and not yet carrying a `deletionTimestamp`. Its
	 * uid then reads as perfectly live, and the handle binds a token the new
	 * agent will refuse, reported as a flat `unauthorized` with nothing
	 * pointing at the race. So the uid is polled, under the SAME deadline as
	 * everything else on this path, until it is a different pod's.
	 *
	 * A failed read is fatal on create and merely "not yet" on resume: for a
	 * stretch of every resume there is no live pod at all, and
	 * {@link readPodBindToken} answers that by throwing rather than returning
	 * undefined. The last such error is carried onto the timeout as `cause`,
	 * so a resume that never found a pod still says what it kept seeing.
	 */
	const acquireBoundPod = async (
		deadline: OperationDeadline,
		previousPodUid: string | undefined,
	): Promise<{ binding: KubernetesSandboxBinding; token: string }> => {
		const label = `workspace ${workspaceId} (Sandbox ${name})`
		let lastError: unknown
		while (deadline.remainingMs() > 0) {
			const binding = await pollForBinding(readBinding, deadline, readiness, label)
			let token: string | undefined
			try {
				token = await deadline.run(
					async (tokenSignal) => await readPodBindToken(client, namespace, binding, tokenSignal),
				)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				if (previousPodUid === undefined) throw err
				lastError = err
				token = undefined
			}
			if (token !== undefined && token !== previousPodUid) return { binding, token }
			try {
				await deadline.delay(readiness.pollIntervalMs)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				throw err
			}
		}
		throw new Error(
			`kubernetes: workspace ${workspaceId} (Sandbox ${name}) was patched back to operatingMode: Running, but ${readiness.timeoutMs}ms later the only pod behind it was still the one it was suspended from (uid ${previousPodUid}). A resumed pod keeps the sandbox's name and gets a new uid, and that uid is the agent's bind token, so binding to the old pod would present a token the new agent refuses. The Ready condition cannot be waited on instead — the controller leaves it standing across the transition. Raise readyTimeoutMs, or look at why the controller has not replaced the pod.`,
			lastError !== undefined ? { cause: lastError } : undefined,
		)
	}

	/**
	 * Bring up one pod's worth of state: wait for a pod that is not the one
	 * being replaced, read its bind token, re-resolve the address, build the
	 * transport and prove the guest is deprivileged. Called on create and on
	 * every resume, with nothing carried over between them.
	 */
	const startSession = async (
		label: string,
		signal?: AbortSignal,
		previousPodUid?: string,
	): Promise<KubernetesSandboxHandle> => {
		const deadline = new OperationDeadline(
			readiness.timeoutMs,
			`kubernetes workspace ${name} ${label}`,
			signal,
		)
		// Both of these are re-read rather than remembered: a resumed pod keeps
		// the name and changes the uid and the IP, so a handle that reused
		// either would present a token the new agent refuses, at an address
		// whose pod is being deleted.
		const { binding, token } = await acquireBoundPod(deadline, previousPodUid)
		// Recorded before the probe, not after: a probe that refuses suspends
		// this pod, and the resume that follows has to know which pod it is
		// waiting to see replaced.
		podUid = token
		const address = resolveAgentAddress(binding, options.agentPort, token)
		// A box rather than a `let`, so the callback below can name the handle
		// it belongs to before that handle exists. Nothing can call it in
		// between: `release` is reachable only THROUGH the handle.
		const own: { handle?: KubernetesSandboxHandle } = {}
		const inner = buildKubernetesSandbox({
			name,
			rootDir: options.rootDir,
			transport: new KubernetesAgentTransport(address),
			// Deliberately NOT `deleteSandbox` — see {@link retireSession}. On
			// the task path `release` is a DELETE because the object is
			// disposable; here the same callback would erase the caller's disk
			// from a path nobody asked to erase anything.
			release: async (releaseSignal) => {
				await retireSession(own.handle, releaseSignal)
			},
			// No `renew`, and so no lease loop: a workspace carries no expiry.
		})
		own.handle = inner
		// The same probe every task acquire runs, on every resume as well as on
		// create — a resumed pod is a new pod, from a possibly re-pulled image,
		// and "it was deprivileged last week" is not a check.
		await probeSandboxPrivileges(inner, name, resolveProbeTimeoutMs(readiness.timeoutMs), signal)
		return inner
	}

	/** Kill and await every terminal this handle returned. */
	const reapTerminals = async (): Promise<void> => {
		const open = [...terminals]
		for (const terminal of open) terminal.kill('SIGKILL')
		await Promise.allSettled(open.map((terminal) => terminal.exited))
		terminals.clear()
	}

	/**
	 * Retire one session's pod WITHOUT deleting anything.
	 *
	 * This is the inner handle's `release` on a workspace, and the difference
	 * from the task path is the entire reason that callback is a parameter
	 * rather than a DELETE both paths share. `buildKubernetesSandbox` calls
	 * `release` on its own initiative: an execution whose cancellation the
	 * guest could not confirm (`RemoteCancellationUnknownError` — a wedged
	 * agent, a partitioned pod) leaves a command of unknown state in that
	 * pod, so the pod stops being reusable and the handle retires it. For a
	 * task sandbox retiring IS deleting, because the object is disposable and
	 * its disk is scratch. Here it is not: the DELETE cascades to the PVC, and
	 * a cancel that went unconfirmed for eight seconds would take a month of
	 * the caller's files with it. `deleteDisk: true` is the only thing in this
	 * module that removes a disk, and a failure path is not allowed to become
	 * a second one — that is the invariant the whole file is built around.
	 *
	 * So the pod is retired the way `suspend()` retires one, with the same
	 * `operatingMode: Suspended` patch, and the workspace is left
	 * `suspending`: nothing is admitted, the disk is untouched, and `resume()`
	 * brings up a fresh pod. A patch that FAILS is not swallowed — it travels
	 * back out through `retire()` as `retirement.accepted === false` on the
	 * error the caller is already receiving, which is what that observation
	 * exists to say.
	 *
	 * `retiring` is the handle the callback was built for. When it is not the
	 * current session there is nothing to retire and this is a no-op: a resume
	 * has already replaced it, or `deleteNow` dropped it on the way to a
	 * DELETE — which must not be preceded by a suspend patch, and says so by
	 * dropping it.
	 *
	 * It never touches the transition queue, and must not: `retire()` is
	 * awaited inside the failing `exec()`, and that exec can be the privilege
	 * probe of the resume currently HOLDING the queue.
	 */
	const retireSession = async (
		retiring: KubernetesSandboxHandle | undefined,
		signal?: AbortSignal,
	): Promise<void> => {
		if (retiring === undefined || retiring !== session) return
		session = undefined
		// Some transition already owns this pod — the suspend that is patching
		// it away, or a create/resume cleanup — and commits its own state when
		// its own request settles. Dropping the session is all there is to do.
		if (state !== 'running') return
		state = 'suspending'
		// Killed but not waited on: the frames go to a pod whose agent has
		// already stopped answering, and whether they are acknowledged must
		// not decide whether the retirement is reported accepted. Every
		// session dies with the pod either way; this is the ownership contract
		// being honoured, not a condition of the patch below. The `catch` is
		// not decoration — a detached chain that rejects with no handler takes
		// the host process down with it.
		void reapTerminals().catch(() => undefined)
		await client.request('PATCH', sandboxPath(namespace, name), SUSPEND_PATCH, signal)
		// The patch landed, so the controller is taking this pod away and the
		// next resume must see it replaced rather than bind it.
		retiredPodUid = podUid
	}

	/**
	 * True once the pod has actually stopped. The POD is asked, and nothing
	 * else is consulted or believed.
	 *
	 * The cheap-looking alternative — the Sandbox's own `Suspended` condition
	 * — is unusable, and upstream says so itself: "the controller does not
	 * currently remove this condition when the Sandbox is resumed, so a stale
	 * Suspended condition may linger after operatingMode returns to Running.
	 * Consumers should treat Ready as the authoritative signal and not infer
	 * the live operating state from the mere presence of this condition"
	 * (`sandbox_types.go`). Reading it would make the second and every later
	 * suspend of the same workspace return immediately, on a True left behind
	 * by the previous one, while the guest was still running and still
	 * writing to the caller's disk — and a `resume()` issued straight after
	 * such a false suspend could bind to the pod that is about to be deleted.
	 *
	 * A `deletionTimestamp` is not the answer either: it is set the moment the
	 * DELETE is accepted, and the container goes on running until it exits or
	 * `terminationGracePeriodSeconds` expires. Gone (404) or stopped
	 * ({@link isPodStopped}) — those are the only two states that mean the
	 * disk is quiesced.
	 */
	const isPodRetired = async (signal?: AbortSignal): Promise<boolean> => {
		try {
			const pod = await client.request<PodResource>(
				'GET',
				podPath(namespace, name),
				undefined,
				signal,
			)
			return isPodStopped(pod)
		} catch (err) {
			if (err instanceof KubernetesAlreadyGoneError) return true
			throw err
		}
	}

	const awaitPodRetired = async (signal?: AbortSignal): Promise<void> => {
		const deadline = new OperationDeadline(
			readiness.timeoutMs,
			`kubernetes workspace ${name} suspend`,
			signal,
		)
		while (deadline.remainingMs() > 0) {
			try {
				if (await deadline.run(isPodRetired)) return
				await deadline.delay(readiness.pollIntervalMs)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				throw err
			}
		}
		throw new KubernetesWorkspaceSuspendTimeoutError(workspaceId, name, readiness.timeoutMs)
	}

	/**
	 * The suspend, minus the queue — every caller here is already inside it.
	 *
	 * `suspending` is entered before the patch and `suspended` only after the
	 * pod is observed stopped, so the two failures each leave the state that
	 * is true: a patch the API server refused leaves the workspace exactly as
	 * it was, still serving calls, and a wait that ran out leaves it refusing
	 * them with the transition still unfinished. Neither can be returned from
	 * by a later `suspend()` as though it had worked.
	 */
	const suspendNow = async (signal?: AbortSignal): Promise<void> => {
		if (state === 'deleted') throw new KubernetesSandboxDestroyedError('suspend', name)
		// `suspending` deliberately falls through: the patch is re-sent and
		// the pod waited for again. Only a CONFIRMED suspend returns here.
		if (state === 'suspended') return
		const before = state
		// A terminal owns an interactive process tree in a pod that is about
		// to be taken away, so it is stopped first — and stays stopped even if
		// the patch below fails. `suspend()` is a declaration that nobody is
		// using this workspace; killing the sessions that say otherwise is the
		// point of it rather than a cost of it.
		await reapTerminals()
		// From here on nothing new is admitted: the pod is going away, and a
		// call let through would dial an address that still resolves — the
		// Service outlives the pod — and hang on a connect timeout naming
		// nothing. This is NOT the terminal state; a patch that fails puts it
		// straight back.
		state = 'suspending'
		try {
			await client.request('PATCH', sandboxPath(namespace, name), SUSPEND_PATCH, signal)
		} catch (err) {
			// Nothing was changed on the cluster, so nothing is changed here:
			// the pod is still running and this handle can still serve it.
			// Marking it suspended would be the defect — every later
			// suspend() and destroy() would return on that mark without ever
			// re-sending the patch, and the pod would run until somebody
			// noticed the bill.
			state = before
			throw err
		}
		// The patch landed, so this pod is the controller's to remove and the
		// next resume must see it replaced rather than bind it — whether or
		// not the wait below is still around when it goes.
		retiredPodUid = podUid
		session = undefined
		await awaitPodRetired(signal)
		state = 'suspended'
	}

	const resumeNow = async (signal?: AbortSignal): Promise<void> => {
		if (state === 'deleted') throw new KubernetesSandboxDestroyedError('resume', name)
		if (state === 'running') return
		// The pod a landed suspend patch took away is one this resume must see
		// replaced rather than bound — see `acquireBoundPod` and
		// `retiredPodUid`. Where there is none to exclude this is one poll
		// plus one read, exactly as it is on create.
		const replacing = retiredPodUid
		await client.request('PATCH', sandboxPath(namespace, name), RESUME_PATCH, signal)
		session = await startSessionOrSuspend('resume', signal, replacing)
		state = 'running'
		// Bound, probed and serving: the pod that was excluded is one no
		// answer can name any more, and the next suspend records its own.
		retiredPodUid = undefined
	}

	/**
	 * Suspend, sharing one transition with any caller already inside it.
	 *
	 * The single-flight slot is taken before the queue so that a second
	 * `suspend()` — or the `destroy()` that is a suspend — awaits this one
	 * instead of patching and waiting all over again once it finishes. It is
	 * released inside the run, before the promise handed to callers settles,
	 * so a caller that awaits and then suspends again gets a fresh attempt.
	 */
	const suspendShared = (signal?: AbortSignal): Promise<void> => {
		pendingSuspend ??= serialise(async () => {
			try {
				await suspendNow(signal)
			} finally {
				pendingSuspend = undefined
			}
		})
		return pendingSuspend
	}

	/**
	 * `destroy()` in its default shape: the suspend above, plus the one thing
	 * a destroy owes a caller that a suspend does not — idempotence over a
	 * workspace somebody already deleted.
	 *
	 * `suspendNow` refuses a deleted workspace, and should: asking to suspend
	 * an object that no longer exists is a mistake worth hearing about. But
	 * `destroy()` is the verb a `finally` block calls, and a body that ends
	 * with an explicit `destroy({ deleteDisk: true })` inside such a block
	 * must not then be handed a `KubernetesSandboxDestroyedError` naming an
	 * operation the caller never typed. What a plain `destroy()` asks for has
	 * happened, more thoroughly than it asked.
	 *
	 * The state is read on both sides of the flight on purpose. Before,
	 * for the ordinary sequential case; after, because the delete can land
	 * while this call waits its turn — a `destroy()` racing a `destroy({
	 * deleteDisk: true })` the queue admitted first must be a no-op in that
	 * order too, which is the order it is most likely to be written in.
	 */
	const destroyBySuspending = async (signal?: AbortSignal): Promise<void> => {
		// Read through a call on both sides. `state` is assigned from other
		// closures, which the checker cannot see, so it takes the first
		// comparison as narrowing the second out of existence — and the second
		// is the one that matters, because it is the one reading a delete that
		// landed while this call was queued.
		const gone = (): boolean => state === 'deleted'
		if (gone()) return
		try {
			await suspendShared(signal)
		} catch (err) {
			if (gone() && err instanceof KubernetesSandboxDestroyedError) return
			throw err
		}
	}

	/**
	 * DELETE the Sandbox, and with it the Pod, the Service and the PVC.
	 *
	 * The terminal state is committed only once the DELETE has resolved —
	 * an object already gone counts, that being the state DELETE was asking
	 * for. A DELETE that FAILS leaves the state alone and rethrows, so the
	 * caller can retry and the next attempt sends the request again. The
	 * inverse — marking `deleted` first — is how an object outlives every
	 * handle that could have removed it: the failure is thrown once, and every
	 * later `destroy()` resolves immediately on a state nothing established.
	 */
	const deleteNow = async (destroyOptions?: KubernetesWorkspaceDestroyOptions): Promise<void> => {
		if (state === 'deleted') return
		await reapTerminals()
		const current = session
		// Dropped BEFORE the handle is torn down, because tearing it down runs
		// its `release` — which on a workspace is {@link retireSession}, a
		// SUSPEND patch. A delete does not want one on the way: the object is
		// going away whole. `retireSession` reads exactly this to know it.
		session = undefined
		// And the state moves with it. The pod is being taken away however the
		// DELETE goes, and the handle that served it is now torn down, so a
		// DELETE that fails leaves a workspace that admits nothing, says so,
		// and can be resumed or deleted again — rather than one still calling
		// itself `running` with no session behind it, which nothing but
		// another delete could ever get out of.
		if (state === 'running') state = 'suspending'
		// Through the inner handle when there is one, so its own terminal
		// reaping and lifecycle bookkeeping run. The DELETE itself is sent
		// here either way, exactly once, and it is retryable: the terminal
		// state below is committed only once it resolves.
		if (current) await current.destroy(destroyOptions)
		await deleteSandbox(destroyOptions?.signal)
		state = 'deleted'
	}

	/** Delete, sharing one DELETE with any caller already inside it. */
	const deleteShared = (destroyOptions?: KubernetesWorkspaceDestroyOptions): Promise<void> => {
		pendingDelete ??= serialise(async () => {
			try {
				await deleteNow(destroyOptions)
			} finally {
				pendingDelete = undefined
			}
		})
		return pendingDelete
	}

	/**
	 * Bring a session up, and put the workspace back to sleep if that fails.
	 *
	 * Suspend rather than delete, always: the failure might be a probe refusal
	 * on a workspace whose disk holds a month of a caller's work, and no
	 * failure path in this module is allowed to make that decision. The cost
	 * of being wrong the other way is one suspended Sandbox left standing,
	 * which the caller finds again under the same deterministic name.
	 */
	const startSessionOrSuspend = async (
		label: string,
		signal?: AbortSignal,
		previousPodUid?: string,
	): Promise<KubernetesSandboxHandle> => {
		try {
			return await startSession(label, signal, previousPodUid)
		} catch (err) {
			// `suspending`, not `suspended`: `runFailureCleanup` swallows its
			// own failures so that the primary error stays primary, which
			// means this patch may not have landed and this pod may still be
			// running. The state says the transition is unfinished, so a
			// later suspend() re-sends it rather than believing this one.
			state = 'suspending'
			session = undefined
			let retired = false
			await runFailureCleanup(async (cleanupSignal) => {
				await client.request('PATCH', sandboxPath(namespace, name), SUSPEND_PATCH, cleanupSignal)
				retired = true
			})
			// Only when the patch came back. A resume that got as far as
			// binding a new pod and then failed its probe has retired THAT
			// pod, and the resume after it must wait for the replacement
			// rather than bind the one this cleanup took away. A cleanup whose
			// patch never landed retired nothing and has nothing to exclude.
			if (retired) retiredPodUid = podUid
			throw err
		}
	}

	const admit = (operation: string): KubernetesSandboxHandle => {
		if (state === 'deleted') throw new KubernetesSandboxDestroyedError(operation, name)
		if (state !== 'running' || session === undefined) {
			throw new KubernetesWorkspaceSuspendedError(operation, workspaceId, name)
		}
		return session
	}

	// The first session is brought up here so that `createKubernetesWorkspace`
	// resolves with a workspace that is Ready, addressed and probed — the same
	// contract `create()` gives a task sandbox.
	session = await startSessionOrSuspend(options.created ? 'create' : 'adopt', options.signal)
	// Whatever the backend's own Sandbox reports, rather than a second copy of
	// the same constant: it must keep answering after a suspend has taken the
	// handle it came from away.
	const environment: SandboxEnvironment = session.environment

	return {
		id,
		get status(): SandboxStatus {
			// A suspended workspace reports 'destroyed' because that is the only
			// member of the SDK's four-way union meaning "cannot serve a call".
			// `suspended` below is what tells the recoverable state apart.
			if (state !== 'running' || session === undefined) return 'destroyed'
			return session.status
		},
		get suspended(): boolean {
			// `suspending` reads as suspended because that is what a caller
			// can DO about it: no call is admitted and `resume()` is the way
			// back. The difference between the two lives where it matters —
			// in `suspendNow`, which returns early on one and not the other.
			return state === 'suspended' || state === 'suspending'
		},
		rootDir: options.rootDir,
		environment,

		async exec(
			command: string,
			argv?: string[],
			execOptions?: SandboxExecOptions,
		): Promise<SandboxExecResult> {
			return await admit('exec').exec(command, argv, execOptions)
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			await admit('writeFile').writeFile(path, content)
		},

		async readFile(path: string): Promise<Buffer> {
			return await admit('readFile').readFile(path)
		},

		async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
			return await admit('listFiles').listFiles(rootPath)
		},

		async openTerminal(terminalOptions: OpenTerminalOptions): Promise<TerminalSession> {
			const terminal = await admit('openTerminal').openTerminal(terminalOptions)
			// Tracked HERE as well as by the inner handle, because a suspend
			// reaps terminals without going through the inner handle's
			// `destroy()` — the pod is being deleted, and a caller left holding
			// a session whose exit resolves only when TCP notices is a leak.
			terminals.add(terminal)
			// `.catch` after `.finally`, not `void` alone: `exited` belongs to
			// the CALLER, who may well let it reject, and a bookkeeping chain
			// hung off it would then reject with no handler and take the host
			// process down on an unhandled rejection.
			void terminal.exited
				.finally(() => {
					terminals.delete(terminal)
				})
				.catch(() => undefined)
			return terminal
		},

		async openTcpConnection(
			connectOptions: SandboxTcpConnectOptions,
		): Promise<SandboxTcpConnection> {
			return await admit('openTcpConnection').openTcpConnection(connectOptions)
		},

		async suspend(transitionOptions?: KubernetesWorkspaceTransitionOptions): Promise<void> {
			await suspendShared(transitionOptions?.signal)
		},

		async resume(transitionOptions?: KubernetesWorkspaceTransitionOptions): Promise<void> {
			// Serialised, and deliberately without a single-flight slot of its
			// own. The two terminal transitions need one because each commits
			// its state only after the cluster confirms it, so a second caller
			// admitted behind the first finds nothing marked and re-sends;
			// `resumeNow` commits `running` at the END of a transition that
			// leaves the workspace usable, and returns early on it, so the
			// second caller finds the work done. Give resume a state it
			// early-returns on before the cluster confirms it and it will need
			// a slot as much as they do.
			await serialise(async () => await resumeNow(transitionOptions?.signal))
		},

		async destroy(destroyOptions?: KubernetesWorkspaceDestroyOptions): Promise<void> {
			if (destroyOptions?.deleteDisk !== true) {
				// The default, and the whole point of the default: there is no
				// delete-compute-keep-disk verb, so the closest thing to one is
				// a suspend, and `destroy()` in a `finally` must not erase a
				// workspace nobody asked to erase. It shares the suspend's
				// single flight, so `destroy()` racing `suspend()` is one
				// transition rather than two — and it stays idempotent over a
				// workspace already deleted, where `suspend()` itself refuses.
				await destroyBySuspending(destroyOptions?.signal)
				return
			}
			await deleteShared(destroyOptions)
		},
	}
}
