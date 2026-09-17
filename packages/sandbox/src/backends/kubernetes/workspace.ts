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
 * Both patches also stamp
 * {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY}. Nothing in this module
 * reads it back; it exists so that an inventory can say when a workspace was
 * last put to sleep without waking it up to ask, which the controller's own
 * lingering `Suspended` condition cannot answer. See
 * {@link listKubernetesWorkspaces}.
 *
 * ## Three verbs that never open a workspace, and one that notices
 *
 * {@link createKubernetesWorkspace} adopts AND resumes, which is right for a
 * host about to USE a workspace and wrong for everything else. Deleting a
 * month-old suspended workspace through it means starting a pod, probing it
 * and deleting it again; taking an inventory means waking every suspended
 * object in the namespace. So the three operations that are about the OBJECT
 * are reachable without a handle — {@link listKubernetesWorkspaces},
 * {@link deleteKubernetesWorkspace} and {@link suspendKubernetesWorkspace} —
 * and none of them creates a pod, dials an agent or resumes anything.
 *
 * The other half of the same problem is the handle that was already open when
 * somebody else did one of those. A workspace id is a name, not a lock, so a
 * second process can suspend the workspace this one is holding, and this
 * handle's `state` is a record of what THIS process did. Two things fix that,
 * and both re-read the object rather than guessing:
 * {@link KubernetesWorkspace.refresh} when the caller asks, and the re-read
 * after a call that FAILED at the transport — which is how it would otherwise
 * be found out, as a connect refusal or a flat `unauthorized` naming nothing.
 * Either one records the suspension as UNCONFIRMED (`suspending`, not
 * `suspended`): what was observed is the object's mode, not the pod stopping,
 * and only a wait this process performed can promise the disk is quiesced.
 *
 * ## Adoption is checked against the object, not against the caller
 *
 * A create that collides with an existing object of the same name ADOPTS it,
 * because the deterministic name is only worth having if coming back is the
 * normal path. What is adopted is then checked against the configuration: the
 * block disk, the `sandbox.namzu.ai/template` pod label (the label the
 * ingress and egress policies select by) and `runtimeClassName` (the VM
 * boundary). A standing object that disagrees with any of them is refused by
 * name rather than driven — see {@link KubernetesWorkspaceMismatchError}. What is NOT
 * checked, and cannot be from here, is whether somebody else is already using
 * it: two host processes can hold handles to one running workspace, and the
 * `destroy()` of either suspends the pod the other is executing in. A
 * workspace id is a name, not a lock.
 *
 * An adopt also has to survive walking in ON a transition, which is the
 * normal way a workspace is found rather than an edge: a suspend that ended
 * in {@link KubernetesWorkspaceSuspendTimeoutError}, a second host coming up
 * during a rollout, a host restarting inside the previous pod's
 * `terminationGracePeriodSeconds`. In all three the pod under the name is
 * draining or already gone, and the replacement has not been created yet. So
 * an adopt that finds the object `Suspended`, or finds its pod carrying a
 * `deletionTimestamp`, WAITS for the replacement under the same readiness
 * budget the resume path waits under, instead of failing on the first read
 * that finds no live pod. What it came by is then reported as `origin`:
 * `created`, `adopted-running` or `resumed` — a host that adopted a pod
 * another process left running needs to know that none of that process's
 * terminals survived it.
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
 * by that same suspend patch (see {@link retireSession}). Exactly two DELETEs
 * are reachable from this module and both are ASKED FOR by name — the one
 * `deleteDisk: true` sends and the one {@link deleteKubernetesWorkspace} is;
 * no failure path, no `finally`, and no default reaches either.
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
	Sandbox,
	SandboxDestroyOptions,
	SandboxEnvironment,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxReadFileOptions,
	SandboxStatus,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	SandboxWalkFilesOptions,
} from '@namzu/sdk'

import { OperationDeadline, OperationDeadlineExpired, runFailureCleanup } from '../readiness.js'
import type { SandboxRetirementObservation } from '../remote-execution-controller.js'
import { RemoteCancellationUnknownError } from '../remote-execution-controller.js'
import {
	type EgressProfileLabel,
	assertEgressPolicyIsEnforceable,
	assertEgressProfileIsUsable,
	composeAdditionalPodLabels,
	egressProfileLabel,
} from './egress-policy.js'
import {
	type KubernetesGuestEvidence,
	type KubernetesGuestRestart,
	KubernetesWorkspaceGuestGoneError,
	type KubernetesWorkspaceIdentity,
	KubernetesWorkspaceReplacedError,
} from './identity.js'
import {
	DEFAULT_AGENT_PORT,
	type KubernetesAgentAddress,
	type KubernetesAgentAddressMode,
	type KubernetesBackendInternalConfig,
	type KubernetesBoundPod,
	type KubernetesSandboxBinding,
	ReadinessPollTimeout,
	type SandboxTemplateCopy,
	bindingFromSandbox,
	buildEgressBoundary,
	buildIngressVerifier,
	buildSandboxBody,
	clientAccess,
	clientOptions,
	pollForBinding,
	probeSandboxPrivileges,
	readBoundPod,
	readSandboxTemplate,
	resolveAgentAddress,
	resolveKubernetesReadiness,
	resolveProbeTimeoutMs,
	resolveStreamHeartbeatMs,
	sandboxPodLabels,
	sandboxPodTemplate,
} from './index.js'
import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	KubernetesConflictError,
	KubernetesPatchNotAppliedError,
	createKubernetesClient,
} from './k8s-client.js'
import {
	HOLDER_EPOCH_ANNOTATION_KEY,
	type HolderEpochReading,
	OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY,
	POD_TEMPLATE_HASH_ANNOTATION_KEY,
	type PodResource,
	SANDBOX_TEMPLATE_LABEL_KEY,
	type SandboxListResource,
	type SandboxPodTemplate,
	type SandboxResource,
	type SandboxVolumeClaimTemplate,
	buildHolderEpochPatch,
	holderEpochAllows,
	isPodStopped,
	persistentVolumeClaimPath,
	podPath,
	podTemplateHash,
	readHolderEpoch,
	readPodTemplateHash,
	sandboxCollectionPath,
	sandboxPath,
} from './objects.js'
import {
	KubernetesSandboxDestroyedError,
	type KubernetesSandboxHandle,
	buildKubernetesSandbox,
} from './sandbox.js'
import {
	KubernetesAgentTransport,
	type KubernetesAttachExecutionOptions,
	type KubernetesAttachTerminalOptions,
	type KubernetesDetachedExecOptions,
	type KubernetesOpenTerminalOptions,
	type KubernetesQuiesceReport,
	KubernetesQuiesceUnconfirmedError,
	KubernetesQuiesceUnsupportedError,
	type KubernetesReadSessionOptions,
	type KubernetesReservedGuest,
	type KubernetesSessionOutput,
	type KubernetesSessionSummary,
	type KubernetesSessionTerminal,
	type KubernetesStartDetachedOptions,
	type KubernetesWorkspaceTerminal,
	guestWhenReserved,
} from './transport.js'

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
 *  - the egress PROFILE label, when `config.egress.profile` is set, for
 *    exactly the same reason: it is the selector's second half. A standing
 *    object built before the profile existed, or under a different one,
 *    carries a pod the per-profile policy does not select — and once each
 *    profile has its own policy object, as it must, a pod carrying neither
 *    key is selected by no egress policy at all. This one is checked only
 *    when a profile is configured: with none, the policy this call verified
 *    selects the template label alone, which the object does carry.
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
		readonly field: 'sandboxTemplateName' | 'egressProfile' | 'runtimeClassName',
		/**
		 * What the configuration asked for. `key=value` for `egressProfile`,
		 * because the KEY is configurable too and the value alone would not
		 * say which label was compared.
		 */
		readonly expected: string,
		/** What the object carries — absent when it carries nothing at all. */
		readonly actual: string | undefined,
		message: string,
	) {
		super(message)
	}
}

/**
 * How a caller came to be told a workspace is suspended.
 *
 *  - `admission` — the handle knew before the call, so nothing was dialed.
 *    Every suspend this handle performed, and every one it has already
 *    noticed, lands here.
 *  - `transport` — the call went out and failed, and the re-read that
 *    followed found the object `Suspended`. Somebody ELSE suspended this
 *    workspace while this handle was holding it; the failure that prompted
 *    the re-read is on `cause`.
 */
export type KubernetesWorkspaceSuspensionNotice = 'admission' | 'transport'

/**
 * Thrown by every operation on a workspace that is currently suspended.
 *
 * Distinct from {@link KubernetesSandboxDestroyedError} because the state is
 * RECOVERABLE and the advice is one word: call `resume()`.
 *
 * `noticedBy` says which of the two ways the caller got here, and the message
 * changes with it, because "nothing was dialed" is a promise the first one
 * keeps and the second one cannot. A workspace another process suspended is
 * discovered by a call FAILING — the pod is gone, so the dial is refused, or
 * the replacement pod's agent refuses this handle's token — and the reason
 * that is worth converting into this error rather than passing on is that the
 * raw failure names nothing: a flat `unauthorized`, or a connect error against
 * an address that still resolves because the Service outlives the pod.
 */
export class KubernetesWorkspaceSuspendedError extends Error {
	override readonly name = 'KubernetesWorkspaceSuspendedError'

	constructor(
		readonly operation: string,
		readonly workspaceId: string,
		readonly sandboxName: string,
		/** See {@link KubernetesWorkspaceSuspensionNotice}. Defaults to `admission`. */
		readonly noticedBy: KubernetesWorkspaceSuspensionNotice = 'admission',
		options?: ErrorOptions,
	) {
		super(
			noticedBy === 'admission'
				? `kubernetes workspace ${workspaceId} (Sandbox ${sandboxName}) is suspended; ${operation}() cannot be admitted and nothing was dialed. Its pod is deleted and its disk is intact — call resume() to get a new pod, a new address and a new agent token, then retry.`
				: `kubernetes workspace ${workspaceId} (Sandbox ${sandboxName}) is suspended; ${operation}() was admitted, failed at the transport, and a re-read of the Sandbox found spec.operatingMode: Suspended — another process suspended this workspace while this handle was holding it. The transport failure is on \`cause\`; it names nothing useful on its own, because the Service outlives the pod and the address still resolves. The disk is intact — call resume() to get a new pod, a new address and a new agent token, then retry.`,
			options,
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

/**
 * Thrown when a lifecycle write carried a holder epoch the workspace has
 * already moved past: the request was NOT sent, or was sent and refused, and
 * nothing on the cluster changed either way.
 *
 * The workspace is somebody else's now. The epoch stored on the Sandbox is
 * higher than the one this call carried, which is what a host says when it
 * hands authority over a workspace to another process — see
 * {@link HOLDER_EPOCH_ANNOTATION_KEY}. A superseded holder that suspends,
 * resumes or deletes anyway would be taking the pod, or the disk, away from
 * whoever holds it now.
 *
 * Nothing about the handle changes either. A refused `suspend()` leaves the
 * handle exactly where it was — still `running`, terminals still open,
 * because the refusal is decided BEFORE they are reaped — so a caller that
 * catches this and re-reads its own holder record has lost nothing.
 *
 * `storedEpoch` is `undefined` in the one case the annotation cannot be read
 * at all: it is present and is not a decimal integer, which no release of
 * this backend writes. `storedAnnotation` carries it verbatim so an operator
 * can see what is actually on the object.
 */
export class KubernetesWorkspacePreconditionError extends Error {
	override readonly name = 'KubernetesWorkspacePreconditionError'

	constructor(
		/** The verb that was refused — `suspend`, `resume`, `destroy`, ... */
		readonly operation: string,
		readonly workspaceId: string,
		readonly sandboxName: string,
		/** The epoch this call carried. */
		readonly epoch: number,
		/** The epoch stored on the Sandbox, or `undefined` if unreadable. */
		readonly storedEpoch: number | undefined,
		/** The annotation exactly as stored, when there is one. */
		readonly storedAnnotation?: string,
	) {
		super(
			storedEpoch === undefined
				? `kubernetes: ${operation}() on workspace ${workspaceId} (Sandbox ${sandboxName}) carried holder epoch ${epoch}, and the Sandbox's ${HOLDER_EPOCH_ANNOTATION_KEY} annotation reads ${JSON.stringify(
						storedAnnotation,
					)}, which is not a decimal integer. No release of this backend writes that, so it was set by hand or by something else; the write was refused rather than overwriting a fence this code does not understand. Nothing on the cluster changed. Fix the annotation, or remove it to start the workspace's epoch again at 0.`
				: `kubernetes: ${operation}() on workspace ${workspaceId} (Sandbox ${sandboxName}) carried holder epoch ${epoch}, but the Sandbox is held at epoch ${storedEpoch} — another process took this workspace over. Nothing on the cluster changed and nothing about this handle changed: its terminals are still open and it is still admitting calls. A host that raised the epoch elsewhere should stop using this handle; one that believes it is still the holder should re-read its own record first.`,
		)
	}
}

/**
 * Refuse an epoch this backend cannot honour, at the entry point rather than
 * at the request — the same place {@link resolveRequestTimeoutMs} refuses a
 * timeout, and for the same reason: a configuration that will never work
 * should be named where the caller can still see which call it came from.
 *
 * Non-negative because the stored value is compared as a number and written
 * as a decimal string, and an integer because a fractional epoch would
 * round-trip through the annotation as something other than what was passed.
 */
function assertHolderEpoch(epoch: number | undefined, where: string): number | undefined {
	if (epoch === undefined) return undefined
	if (!Number.isSafeInteger(epoch) || epoch < 0) {
		throw new Error(
			`kubernetes: ${where} epoch must be a non-negative safe integer, got ${JSON.stringify(
				epoch,
			)}. It is stored on the Sandbox as a decimal string and compared as a number, so anything else could not be written back as the value that was passed.`,
		)
	}
	return epoch
}

/**
 * Refuse a `quiesce` asked of a verb that has no guest to ask.
 *
 * {@link suspendKubernetesWorkspace} reaches a workspace WITHOUT opening one:
 * it sends a patch and waits for the pod, and never dials the agent. So there
 * is nothing there that could stop a process, and silently ignoring the flag
 * would hand a caller a suspend it believes was preceded by a quiesce —
 * exactly the belief this whole feature exists to make true. The handle's
 * `suspend()` is the verb that can do it, and the message says so.
 */
function assertNoQuiesceHere(
	quiesce: KubernetesWorkspaceQuiesceRequest | undefined,
	where: string,
): void {
	if (quiesce === undefined || quiesce === false) return
	throw new Error(
		`kubernetes: ${where} cannot quiesce the guest: it reaches the workspace through the API server alone and never dials the agent, so there is no connection on which to stop anything. Open the workspace with createKubernetesWorkspace() and call suspend({ quiesce: true }) on the handle, or quiesce() and then this. The option is refused rather than ignored, because a caller that passed it is about to trust a capture.`,
	)
}

/**
 * What a start that FAILED is allowed to do to the workspace it was starting
 * in.
 *
 *  - `suspend-if-woken` (the default) — send the `operatingMode: Suspended`
 *    patch only when this call is the one that moved the mode: it POSTed the
 *    object, or its Running patch took the object out of `Suspended`. That
 *    keeps the case the rule exists for — a workspace this call WOKE and then
 *    failed to start would otherwise be left Running with a pod nobody is
 *    using, burning a node until somebody notices — while never taking a pod
 *    away from a holder who was already using it.
 *  - `leave` — never patch, on any start failure, without exception. For a
 *    host that keeps its own holder record and sweeps idle workspaces itself:
 *    the cost of being wrong is one Running workspace nobody is in, which
 *    that host can already see and already sweeps.
 *
 * Read only by the paths that START a session: {@link
 * createKubernetesWorkspace} and `resume()`. `suspend()`, `refresh()`,
 * `destroy()` and the three standalone verbs start nothing and ignore it.
 */
export type KubernetesWorkspaceStartFailurePolicy = 'suspend-if-woken' | 'leave'

/**
 * What one bounded `healthz` found after a cancellation went unconfirmed —
 * the fact the host needs and the error cannot carry.
 *
 *  - `ok` — the agent answered and is serving normally. The command whose
 *    cancellation could not be confirmed may still be running in that pod,
 *    but nothing is wedged; the workspace goes on working.
 *  - `retiring` — the agent has FENCED itself: it could not confirm that a
 *    process group was gone, so it refuses every op but `healthz` and
 *    `cancel-execution` and will until the pod is replaced. This is the one
 *    case where `suspend()` then `resume()` is the cure.
 *  - `unreachable` — the probe could not get an answer at all: the pod is
 *    gone, the network is out, or the address stopped resolving. Nothing can
 *    be concluded about the command, and nothing should be done about the
 *    workspace on this alone — the next call finds out, and a foreign suspend
 *    is reported as one.
 */
export type KubernetesWorkspaceAgentState = 'ok' | 'retiring' | 'unreachable'

/**
 * What {@link KubernetesWorkspaceOptions.onCancellationUnconfirmed} is told.
 *
 * It is a NOTIFICATION, not a decision point: the `exec()` this came from
 * rejects with `error` whatever the callback does, and nothing the callback
 * does is awaited by the failing call beyond the moment it returns.
 */
export interface KubernetesWorkspaceCancellationNotice {
	/** The `RemoteCancellationUnknownError` the caller is about to receive. */
	readonly error: Error
	/** See {@link KubernetesWorkspaceAgentState}. */
	readonly agent: KubernetesWorkspaceAgentState
	/**
	 * What a bounded look at the pod and the agent process found — see
	 * {@link KubernetesGuestEvidence}.
	 *
	 * It answers the question `agent` cannot: `healthz` says whether SOME
	 * agent is serving at that address, and this says whether it is the same
	 * one the command was running in. Anything but `same-guest` means the
	 * command cannot still be running, because the process tree it belonged
	 * to is gone — and that a suspend would take a pod nobody's command is in.
	 */
	readonly guest: KubernetesGuestEvidence
	/** The guest the command was started on. */
	readonly previous: KubernetesWorkspaceIdentity
	/** The guest standing under the workspace's name now. */
	readonly current: KubernetesWorkspaceIdentity
}

/**
 * Authority for one workspace operation, owned independently of the run.
 *
 * Carried by the handle's transitions and by the three verbs that reach a
 * workspace without opening one ({@link listKubernetesWorkspaces},
 * {@link deleteKubernetesWorkspace}, {@link suspendKubernetesWorkspace}) —
 * one shape rather than four, because a cancellation scope is what all of
 * them take and the one verb among them that starts a session takes one
 * thing more.
 */
export interface KubernetesWorkspaceTransitionOptions {
	readonly signal?: AbortSignal
	/**
	 * Override, for this call only, what a failed start may do to the
	 * workspace — see {@link KubernetesWorkspaceStartFailurePolicy}. Defaults
	 * to whatever the handle was opened with, which defaults to
	 * `suspend-if-woken`.
	 *
	 * `resume()` is the only verb on this shape that reads it, because it is
	 * the only one that starts a session. It is declared here rather than on
	 * a resume-only shape so that a host passing one options object to every
	 * transition does not have to know which verb consults which field.
	 */
	readonly onStartFailure?: KubernetesWorkspaceStartFailurePolicy
	/**
	 * The holder epoch this call writes under — see
	 * {@link HOLDER_EPOCH_ANNOTATION_KEY}.
	 *
	 * The write applies when the epoch stored on the Sandbox is `<=` this
	 * one, and stores this one in the same request; a stored epoch above it
	 * refuses the write with {@link KubernetesWorkspacePreconditionError} and
	 * changes nothing. Omitted, every request goes out exactly as it did
	 * before epochs existed, merge-patch content type included — this fences
	 * nothing until a host opts in.
	 *
	 * Read by every verb on this shape that WRITES: `suspend()`, `resume()`,
	 * `destroy()` and the standalone
	 * {@link suspendKubernetesWorkspace} / {@link deleteKubernetesWorkspace}.
	 * `refresh()`, `cancelExecution()` and {@link listKubernetesWorkspaces}
	 * send no write, so there is nothing for an epoch to condition there and
	 * they ignore it — the same way `onStartFailure` above is ignored by
	 * every verb that starts no session. A list REPORTS each workspace's
	 * stored epoch instead, on
	 * {@link KubernetesWorkspaceSummary.holderEpoch}.
	 *
	 * A handle that was opened with one, or last resumed with one, uses it
	 * for every write it sends when the call passes none — including the
	 * patch a failed start's cleanup sends.
	 */
	readonly epoch?: number
	/**
	 * Write the SandboxTemplate's CURRENT `spec.podTemplate` onto the
	 * workspace as it wakes, keeping its disk — see
	 * {@link KubernetesWorkspace.templateRevision}.
	 *
	 * `resume()` is the only verb on this shape that reads it, in the same
	 * way `onStartFailure` above is read only by the verb that starts a
	 * session. It is honoured on exactly one transition — a workspace
	 * observed `Suspended` going back to `Running` — because the controller
	 * does not rewrite a pod that already exists, so a Running workspace
	 * patched this way would carry a spec describing a pod it is not running.
	 * A `resume()` of a workspace that is already awake, and one whose
	 * condition loses to another process's resume, send no pod template and
	 * bind the pod that is there.
	 *
	 * Omitted or `false`, `resume()` sends exactly the single merge patch it
	 * always sent.
	 */
	readonly refreshPodTemplate?: boolean
}

/**
 * What a SUSPEND takes, which is every transition option plus the one thing
 * only a suspend can do with it.
 *
 * `quiesce` lives here rather than on
 * {@link KubernetesWorkspaceTransitionOptions} so that the verbs which
 * cannot honour it — `resume()`, `refresh()`, {@link listKubernetesWorkspaces}
 * and {@link deleteKubernetesWorkspace}, none of which sends a patch a
 * quiesce could precede — do not accept it and then ignore it. A caller who
 * passed it is about to trust a capture, and a silently dropped flag is the
 * one way this feature could lie.
 */
export interface KubernetesWorkspaceSuspendOptions extends KubernetesWorkspaceTransitionOptions {
	/**
	 * Stop every process in the guest BEFORE the `Suspended` patch goes out —
	 * see {@link KubernetesWorkspace.quiesce}, which this runs.
	 *
	 * Honoured by the handle's `suspend()` and by the `destroy()` that
	 * suspends. The standalone {@link suspendKubernetesWorkspace} takes this
	 * same shape and REFUSES the flag rather than ignoring it: it reaches the
	 * workspace through the API server alone and never dials the agent, so
	 * there is no connection on which it could stop anything. Off by default,
	 * so a `suspend()` that does not name it is byte-for-byte the suspend it
	 * always was.
	 *
	 * A guest whose image predates the op keeps today's behaviour: the
	 * suspend proceeds and
	 * {@link KubernetesWorkspaceOptions.onQuiesceUnsupported} is told. A
	 * quiesce the guest ANSWERED and could not confirm is different — the
	 * suspend rejects and sends no patch, leaving the workspace running,
	 * because the state that is true is the one this handle records. And a
	 * suspend ALREADY IN FLIGHT without a quiesce is refused rather than
	 * joined — see `suspend()`.
	 */
	readonly quiesce?: KubernetesWorkspaceQuiesceRequest
}

/**
 * `quiesce()`'s own options.
 *
 * `signal` is the `AbortSignal` that cancels the REQUEST, as it is on every
 * other verb on this handle. There is deliberately no POSIX-signal field to
 * go with it: the escalation is the guest's and is fixed — `SIGTERM`, then
 * `SIGKILL` on whatever is left — because a caller-chosen signal that a
 * process ignores would turn a quiesce into a call that resolves having
 * stopped nothing.
 */
export interface KubernetesQuiesceOptions {
	/**
	 * How long the guest waits after `SIGTERM` before escalating to
	 * `SIGKILL`, per round. The guest refuses a value at or above its own
	 * cancel-confirmation timeout (5000ms by default) and defaults to
	 * 1000ms.
	 *
	 * It is NOT the pod's `terminationGracePeriodSeconds`, which bounds how
	 * long the kubelet waits after the pod has been asked to stop. This one
	 * bounds a round of an op the host called while the pod is still running
	 * and still serving.
	 */
	readonly graceMs?: number
	readonly signal?: AbortSignal
}

/**
 * What `suspend({ quiesce })` and `destroy({ quiesce })` ask for: `true`
 * for the guest's own default window, or an object naming `graceMs`.
 */
export type KubernetesWorkspaceQuiesceRequest = boolean | { readonly graceMs?: number }

/**
 * `killSession()`'s two signals, which are different things and are named
 * apart for that reason: `signal` is the POSIX signal the guest sends to the
 * session, and `abort` is the `AbortSignal` that cancels the REQUEST.
 * Collapsing them into one field called `signal` is how a caller ends up
 * sending `SIGKILL` to a shell it only meant to stop asking about.
 */
export interface KubernetesKillSessionOptions {
	/** `SIGTERM`, `SIGKILL`, `SIGINT` or `SIGHUP`. Default `SIGKILL`. */
	readonly signal?: string
	readonly abort?: AbortSignal
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
	/**
	 * The holder epoch this destroy writes under — see
	 * {@link KubernetesWorkspaceTransitionOptions.epoch}, which it means
	 * exactly the same thing as.
	 *
	 * It fences both shapes of `destroy()`: the default's suspend patch and
	 * `deleteDisk: true`'s DELETE, the latter through a
	 * `preconditions.resourceVersion` on the version whose epoch was read. A
	 * retention job superseded between its check and its call takes nobody's
	 * disk.
	 */
	readonly epoch?: number
	/**
	 * Stop every process in the guest first — see
	 * {@link KubernetesWorkspaceSuspendOptions.quiesce}, which this means
	 * exactly the same thing as.
	 *
	 * It is read by the `destroy()` that SUSPENDS, which is the default one.
	 * A `destroy({ deleteDisk: true })` ignores it: the disk it would be
	 * quiescing is about to be deleted along with everything on it.
	 */
	readonly quiesce?: KubernetesWorkspaceQuiesceRequest
}

/**
 * How a {@link KubernetesWorkspace} handle came by its workspace.
 *
 *  - `created` — this call POSTed the Sandbox. The pod is this process's own
 *    and the disk is empty.
 *  - `adopted-running` — an object of that name already stood, already
 *    Running. The pod predates this handle, and usually predates this
 *    process.
 *  - `resumed` — an object of that name stood Suspended and this call patched
 *    it back to Running. The disk is whatever the last holder left on it; the
 *    pod is brand new.
 */
export type KubernetesWorkspaceOrigin = 'created' | 'adopted-running' | 'resumed'

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
	 * How this handle came by its workspace — see
	 * {@link KubernetesWorkspaceOrigin}.
	 *
	 * Fixed for the handle's life. It answers "what did this call walk into",
	 * not "what state is the workspace in now", which is what `suspended` is
	 * for; a later suspend/resume cycle does not rewrite it.
	 *
	 * It is reported because the two adopted values mean a pod this process
	 * did not start, and a host reattaching to a workspace another process
	 * left behind has to know what of that process's work is still there. On
	 * `resumed` the pod is new, so nothing survived but the disk. On
	 * `adopted-running` the guest's agent is the same process it was and a
	 * detached background command may still be running — but no TERMINAL is:
	 * the agent kills a terminal's process group the moment its connection
	 * closes, and the previous host's connections closed with the host. A
	 * caller that reopens terminals unconditionally on this value is right;
	 * one that assumes it can reattach to them is not.
	 */
	readonly origin: KubernetesWorkspaceOrigin
	/**
	 * The revision of the pod template the BOUND Sandbox carries — the value
	 * of its `sandbox.namzu.ai/pod-template-hash` annotation.
	 *
	 * A Sandbox's `spec.podTemplate` is a copy of the SandboxTemplate's,
	 * taken once, and the controller builds every replacement pod from that
	 * copy — so a workspace kept for weeks runs the pod spec it was created
	 * with. This is what the object recorded it was built from.
	 *
	 * `undefined` for a workspace created before the annotation existed, and
	 * for one an older release last wrote. That is reported as unknown rather
	 * than guessed from the stored spec: a comparison this backend invents
	 * would be a second, weaker copy of the overlay rules.
	 */
	readonly templateRevision: string | undefined
	/**
	 * Whether {@link templateRevision} matched the SandboxTemplate this
	 * handle last read.
	 *
	 * `false` means a suspend and a resume with
	 * {@link KubernetesWorkspaceTransitionOptions.refreshPodTemplate} would
	 * change what this workspace runs — a new image tag, a memory limit, a
	 * grace period, an env entry. A host can schedule that at a moment of its
	 * choosing instead of finding out when a release makes the stored image
	 * fail every start.
	 *
	 * A workspace with no recorded revision reads `false`: unknown is not
	 * current. The template is read when the handle is opened and again on
	 * every refresh, so a `resume()` WITHOUT the option leaves this answering
	 * against the last template this handle read rather than paying a GET for
	 * one nothing is going to be compared to.
	 */
	readonly templateCurrent: boolean
	/**
	 * The four objects this handle is bound to RIGHT NOW — see
	 * {@link KubernetesWorkspaceIdentity}.
	 *
	 * Read fresh on every access rather than snapshotted, because it moves:
	 * `podUid` changes across a suspend/resume and across a pod this handle
	 * rebound to, `guestBootId` changes when the kubelet restarts the
	 * container, and both are `undefined` while this handle holds no pod — a
	 * suspended or destroyed workspace. A resume that has BOUND its pod names
	 * it from that moment, probe included, so a listener reading this from
	 * inside a `pod-replaced` event raised during a resume is answered with
	 * the pod it was just told about rather than with nothing.
	 * `sandboxUid` and `volumeClaimUids` do not move for the life of a handle
	 * — a handle whose object was replaced refuses rather than following it.
	 *
	 * A host that keeps per-workspace state compares this across calls, or
	 * (better) subscribes with {@link onGuestRestart} and is told.
	 */
	readonly identity: KubernetesWorkspaceIdentity
	/**
	 * Be told when the guest behind this handle is replaced, and get back the
	 * function that stops being told.
	 *
	 * This is the honest half of the rebind. A handle that follows a replaced
	 * pod keeps WORKING, which is what a caller wants; what it cannot do is
	 * keep the caller's guest state, because every process that pod was
	 * running died with it. A host that remembers what it started — a dev
	 * server, a watcher, a shell — must subscribe, or it will go on believing
	 * in processes that no longer exist while every call succeeds.
	 *
	 * It fires for a pod the handle rebound to (`pod-replaced`) and for an
	 * agent process that was restarted inside the same pod
	 * (`container-restarted`, recognised only against a guest that reports a
	 * `guestBootId`). It does NOT fire across the caller's own `suspend()`
	 * and `resume()`: that pod change was asked for, and a host that issued
	 * it already knows its processes are gone. The one exception is a pod
	 * replaced by somebody else DURING a resume — between the pod this
	 * handle bound and the privilege probe that follows it — where the probe
	 * is refused, the handle rebinds, and a `pod-replaced` event is
	 * announced. That is a pod change the caller did not ask for, arriving
	 * inside a transition it did; reporting it is the point.
	 *
	 * Every event names both pods, that one included. The payload is built
	 * from the uids the routine announcing the move is holding — not read
	 * back off a handle whose transition has not finished — so there is no
	 * path on which a listener is told its guest moved and not told where
	 * from or where to.
	 *
	 * On a `pod-replaced` event `current.guestBootId` is `undefined`: the
	 * replacement has not answered yet, so there is no process to name.
	 * `current.podUid` is what moved, and `identity` names the process that
	 * answered from there once the call that rebound has returned.
	 *
	 * Listeners are called synchronously, in subscription order, and a
	 * listener that throws is swallowed — the event is a notification and
	 * must not fail the call that discovered it.
	 */
	onGuestRestart(listener: (event: KubernetesGuestRestart) => void): () => void
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
	/**
	 * The SDK's `exec`, plus the three Kubernetes-only fields that let a
	 * command outlive the connection watching it — see
	 * {@link KubernetesDetachedExecOptions}.
	 *
	 * Without `executionId` and without `detach` this is the SDK's exec
	 * exactly: the same reserve-before-admission controller, the same wire
	 * request, the same result. The options type only WIDENS what is
	 * accepted, so every `SandboxExecOptions` a caller already passes is
	 * still a valid argument and nothing about `Sandbox` changed.
	 */
	exec(
		command: string,
		argv?: string[],
		options?: KubernetesDetachedExecOptions,
	): Promise<SandboxExecResult>
	/**
	 * Read a command this workspace is running, or has recently run, by the
	 * id it was started with — including one started by a host process that
	 * no longer exists.
	 *
	 * It never signals the command: aborting `signal` stops reading and
	 * leaves it running, and closing the connection changes nothing in the
	 * guest. Every attach inside the retention window returns the same
	 * result. Past it, or in a pod that has since been replaced, it rejects
	 * with `KubernetesExecutionNotAttachableError`.
	 */
	attachExecution(
		executionId: string,
		options?: KubernetesAttachExecutionOptions,
	): Promise<SandboxExecResult>
	/**
	 * End a command by id, from any process holding the id. Resolves only
	 * on a CONFIRMED termination and rejects with
	 * `RemoteCancellationUnknownError` otherwise — and rejecting here
	 * retires nothing: the workspace, its pod and its disk are left exactly
	 * as they are. A caller that wants the pod gone asks for that.
	 */
	cancelExecution(
		executionId: string,
		options?: KubernetesWorkspaceTransitionOptions,
	): Promise<void>
	/**
	 * A guest PTY. Without `sessionId` and `persistent: true` this is exactly
	 * the terminal it has always been — same wire request, same behaviour —
	 * except that its teardown now reaches the whole session rather than only
	 * `script`'s process group, so a job the shell backgrounded no longer
	 * outlives the terminal that started it.
	 *
	 * With them the PTY belongs to the pod rather than to this connection:
	 * losing the connection DETACHES, and {@link attachTerminal} rejoins the
	 * same shell from another process. `exited` on such a terminal rejects
	 * with `AgentSessionDetachedError` when the attachment ends and the
	 * program does not, because resolving it would claim an exit that never
	 * happened.
	 */
	openTerminal(options: KubernetesOpenTerminalOptions): Promise<KubernetesWorkspaceTerminal>
	/**
	 * Rejoin a terminal session by the id it was opened with — from this
	 * process or from one that replaced it.
	 *
	 * The guest replays from `fromOffset` and then follows live, so a reader
	 * starting at 0 sees what the shell printed while nobody was watching,
	 * and is told how much the ring had to evict. At most one attachment
	 * exists at a time: a second attach ends the first by name rather than
	 * letting two processes interleave keystrokes into one shell.
	 */
	attachTerminal(
		sessionId: string,
		options?: KubernetesAttachTerminalOptions,
	): Promise<KubernetesSessionTerminal>
	/**
	 * Start a program with no terminal, in its own kernel session, with
	 * stdin closed and both output streams going into the guest's retained
	 * log.
	 *
	 * This is not the SDK's `spawnDetached` and does not pretend to be: that
	 * hands back a host `ChildProcess`, which cannot cross a process
	 * boundary, and it stays absent here. What this returns is a NAME, and
	 * the name is what another host process comes back with.
	 */
	startDetached(options: KubernetesStartDetachedOptions): Promise<KubernetesSessionSummary>
	/**
	 * Read a session's output from `fromOffset` without attaching to it and
	 * without signalling anything — the chunk, the offset to come back with,
	 * the bytes the ring dropped before it, and the program's status.
	 */
	readSession(
		sessionId: string,
		options?: KubernetesReadSessionOptions,
	): Promise<KubernetesSessionOutput>
	/**
	 * Every session this workspace's pod is holding, running and recently
	 * exited. Empty after a suspend and resume: the registry is the pod's
	 * memory, and a resumed workspace is a new pod.
	 */
	listSessions(
		options?: KubernetesWorkspaceTransitionOptions,
	): Promise<readonly KubernetesSessionSummary[]>
	/**
	 * End one session and everything still in it — the shell, the jobs it
	 * backgrounded, and whatever a detached session started. Idempotent, and
	 * the reply says what the session's state actually is, so a program that
	 * ignored a `SIGTERM` is reported still running rather than reported
	 * dead.
	 *
	 * `options.signal` is the POSIX signal to send (`SIGKILL` by default);
	 * `options.abort` is the `AbortSignal` that cancels the request.
	 */
	killSession(
		sessionId: string,
		options?: KubernetesKillSessionOptions,
	): Promise<KubernetesSessionSummary>
	openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection>
	/**
	 * Narrowed to present, like the two above: the pod behind a workspace runs
	 * the same guest agent a task sandbox does, so bounded file discovery is
	 * always available here and a caller composing this handle does not have
	 * to re-check for a method the backend always defines. The SDK's `glob`
	 * and `grep` builtins refuse a sandbox that omits it.
	 */
	walkFiles(rootPath: string, options: SandboxWalkFilesOptions): AsyncIterable<SandboxFileEntry>
	/**
	 * Narrowed to PRESENT, like the three above: the pod behind a workspace
	 * runs this repository's agent, so the streamed read is never absent
	 * here and a host draining a large output file before `suspend()` or
	 * `destroy()` — the use a long-lived workspace exists for — does not
	 * have to check for it.
	 */
	readFileStream(path: string, options?: SandboxReadFileOptions): AsyncIterable<Buffer>
	/**
	 * Re-read `spec.operatingMode` and believe it: a workspace ANOTHER
	 * process suspended reports `suspended: true` afterwards, and `resume()`
	 * brings it back on the same disk.
	 *
	 * A workspace id is a name, not a lock — two host processes can hold
	 * handles to one workspace — and everything else on this handle reports
	 * what THIS process did. Without this verb the second process has no way
	 * to ask, and its handle goes on claiming to be running with no pod
	 * behind it until a call fails.
	 *
	 * The foreign suspend is recorded as UNCONFIRMED, not as finished: what
	 * was observed is the object's mode, not the pod stopping, so a later
	 * `suspend()` on this handle still sends its own patch and waits for the
	 * pod rather than returning on what this read saw. Every terminal this
	 * handle handed out is killed, because the pod they live in is being
	 * taken away.
	 *
	 * It notices a suspension and nothing else. A workspace that reads
	 * `Running` while this handle is suspended is NOT taken back — coming
	 * back means binding a new pod, reading its token and probing it, which
	 * is what `resume()` is. A workspace somebody DELETED rejects with the
	 * client's already-gone error and changes nothing here: there is no state
	 * on this handle that means "another process deleted it", and inventing
	 * one to report it is a larger change than this verb.
	 */
	refresh(options?: KubernetesWorkspaceTransitionOptions): Promise<void>
	/**
	 * Stop every process this workspace's pod is running, and go on serving.
	 *
	 * `suspend()` on its own reaches two kinds of process: the terminals THIS
	 * handle returned, and a command somebody cancelled by id. A terminal
	 * another host process opened, a command already in flight, and above all
	 * a program that moved into a session of its own with `setsid` and was
	 * then reparented away from the agent all keep running — and keep writing
	 * to the disk — until the pod stops. By then there is no agent left to
	 * read that disk through.
	 *
	 * So this is the verb for a host that wants the disk still WHILE IT CAN
	 * STILL READ IT: afterwards the guest is quiet and the agent is up, so
	 * `exec`, `readFile`, `readFileStream` and `writeFile` all work and what
	 * they see is a filesystem nobody is writing to. A capture taken here can
	 * be trusted; `destroy({ deleteDisk: true })` or
	 * {@link deleteKubernetesWorkspace} can then run against a workspace
	 * nobody has to wake again to check.
	 *
	 * What it costs is everything running: an open terminal receives its
	 * exit, a running `exec` resolves with a signal in its result, and a
	 * session in the registry is reported `exited` rather than detached. A
	 * second call straight after the first stops nothing and says so, with an
	 * empty list.
	 *
	 * Admitted only while the workspace is running, and serialised with the
	 * lifecycle transitions, so it cannot interleave with a suspend or a
	 * resume. It rejects — changing nothing on the cluster — with
	 * `KubernetesQuiesceUnconfirmedError` when a process would not stop (the
	 * message names its pid), and with `KubernetesQuiesceUnsupportedError`
	 * against an image whose agent predates the op.
	 */
	quiesce(options?: KubernetesQuiesceOptions): Promise<KubernetesQuiesceReport>
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
	 *
	 * `suspend({ quiesce: true })` runs {@link quiesce} first — after this
	 * handle's own terminals are reaped and BEFORE the patch — so the disk is
	 * still at the moment the pod is asked to stop rather than merely by the
	 * time it has. A quiesce that cannot be confirmed rejects and sends NO
	 * patch: the workspace stays running and admits calls, which is the rule
	 * this verb already keeps everywhere else — leave the state that is true.
	 *
	 * Sharing a transition has ONE exception, and it is this option. A call
	 * arriving mid-suspend joins the transition in flight rather than
	 * starting one of its own, under the first caller's signal and epoch —
	 * but a `quiesce` the transition in flight is not performing cannot be
	 * joined into: that transition is on its way to patching over a guest
	 * nothing has stopped, and once its state leaves `running` no call is
	 * admitted to stop anything. Such a caller is REJECTED with
	 * {@link KubernetesQuiesceUnconfirmedError} instead of being handed a
	 * resolved suspend it would trust a capture on. A caller whose request
	 * the flight already satisfies still joins it.
	 */
	suspend(options?: KubernetesWorkspaceSuspendOptions): Promise<void>
	/**
	 * Take a new pod, on a new address, with a new agent token, and prove it
	 * is deprivileged before handing it back. Idempotent: resuming a running
	 * workspace sends nothing.
	 *
	 * With
	 * {@link KubernetesWorkspaceTransitionOptions.refreshPodTemplate}, the
	 * wake-up patch also writes the SandboxTemplate's current
	 * `spec.podTemplate`, so the new pod is built from the template as it
	 * stands rather than as it stood when the workspace was created. The disk
	 * is untouched — `spec.volumeClaimTemplates` is CEL-immutable and is not
	 * in the patch — and a template that no longer claims this workspace's
	 * disk is refused with {@link KubernetesWorkspaceDiskError} before
	 * anything is sent.
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
	/**
	 * What a failed start may do to the workspace, for this handle and every
	 * transition on it — see {@link KubernetesWorkspaceStartFailurePolicy}.
	 * Default: `suspend-if-woken`.
	 */
	readonly onStartFailure?: KubernetesWorkspaceStartFailurePolicy
	/**
	 * Told when an execution's cancellation could not be CONFIRMED, with
	 * what a bounded `healthz` found afterwards — see
	 * {@link KubernetesWorkspaceCancellationNotice}.
	 *
	 * Nothing happens to the workspace on this path: the pod keeps running,
	 * no patch is sent, the handle goes on admitting calls, and the failing
	 * `exec()` rejects with `RemoteCancellationUnknownError` carrying
	 * `retirement: { accepted: false, reason: 'workspace-kept' }`. A command
	 * of unknown state is left in that pod, which is a fact the host has to
	 * be able to act on — so it is reported here rather than acted on from
	 * inside a failing call, where the only action available (the Suspended
	 * patch) would delete the pod out from under every other holder.
	 *
	 * A host that wants the old behaviour calls `suspend()` from this
	 * callback. One that wants it only for a genuinely fenced agent calls it
	 * when `agent` is `retiring`.
	 *
	 * Not only from `exec()`. The acquire-time PRIVILEGE PROBE is itself an
	 * execution on the same inner handle, so a create or a resume whose probe
	 * loses its cancellation fires this too — and pays the diagnosis's own
	 * bound before rejecting. A callback that suspends the workspace is
	 * therefore reachable from a failing START as well as from a failing
	 * call, which is worth knowing before it is wired to one.
	 *
	 * In the style of `onLeaseRenewalError`: synchronous, never awaited, and
	 * a callback that throws changes nothing about the error the caller
	 * receives.
	 */
	readonly onCancellationUnconfirmed?: (notice: KubernetesWorkspaceCancellationNotice) => void
	/**
	 * Told when a `suspend({ quiesce: true })` could not quiesce because the
	 * guest's image predates the op, just before the suspend goes ahead
	 * without one.
	 *
	 * This is the one gap that must not be silent. Everything else about a
	 * quiesce is reported by the call that asked for it — `quiesce()` itself
	 * refuses an image that cannot perform one, and a quiesce the guest
	 * answered and could not confirm rejects the suspend — but a host that
	 * passes `quiesce: true` and gets a suspend anyway would otherwise have
	 * no way to learn that its capture was taken over a guest nothing had
	 * stopped. `@namzu/sandbox` owns no logger and reads none from module
	 * scope, so the diagnostic goes to the host that has one.
	 *
	 * In the style of `onLeaseRenewalError`: synchronous, never awaited, and
	 * a callback that throws changes nothing about the suspend.
	 */
	readonly onQuiesceUnsupported?: (error: KubernetesQuiesceUnsupportedError) => void
	/**
	 * Told when a `suspend({ quiesce: true })` DID quiesce, and the guest
	 * narrowed the scan to the kernel sessions its own registries own —
	 * `report.scope === 'owned-sessions'` — just before the patch goes out.
	 *
	 * The sibling of `onQuiesceUnsupported`, and it exists for the same
	 * reason: `quiesce()` hands its caller the report and that caller can
	 * read the scope, but a `suspend({ quiesce: true })` returns `void`, so
	 * the one path that cannot read the report would otherwise be the one
	 * that silently under-delivers. A narrowed scan can miss exactly the
	 * process this feature exists for — a program `setsid` moved out of
	 * every session either registry holds — so a capture taken after one is
	 * weaker than a capture taken after a `pid-namespace` scan.
	 *
	 * A pod built from this repo's image never narrows: `k8s/entrypoint.sh`
	 * makes `tini` PID 1 and the agent its child. A derived image that wraps
	 * the agent in something else, or an embedded agent, can.
	 *
	 * In the style of `onLeaseRenewalError`: synchronous, never awaited, and
	 * a callback that throws changes nothing about the suspend.
	 */
	readonly onQuiesceNarrowed?: (report: KubernetesQuiesceReport) => void
	/**
	 * The holder epoch this call opens the workspace under, and the one the
	 * handle keeps — see {@link HOLDER_EPOCH_ANNOTATION_KEY}.
	 *
	 * On the CREATE path the POST stamps it, so the workspace is fenced from
	 * the moment it exists. On the ADOPT path it is checked against the
	 * stored epoch before anything is patched — an opener the workspace has
	 * moved past is refused with
	 * {@link KubernetesWorkspacePreconditionError} and wakes nothing — and
	 * then written, even when the object was already `Running` and today
	 * nothing would be sent: taking a workspace over is exactly the moment
	 * the fence has to move.
	 *
	 * The handle then uses it for every write it sends when the call passes
	 * none: `suspend()`, `destroy()`, and the cleanup patch a failed start
	 * sends. Omitted, nothing is fenced and every request is what it was.
	 */
	readonly epoch?: number
	/**
	 * On the ADOPT path, write the SandboxTemplate's current
	 * `spec.podTemplate` onto the workspace as it wakes — the same opt-in
	 * {@link KubernetesWorkspaceTransitionOptions.refreshPodTemplate}
	 * describes, reachable from an entry point that needs no handle.
	 *
	 * It exists here because a host that restarted has no handle to call
	 * `resume()` on: the workspace is found again by name, and this call is
	 * the only place the decision can be made. It is honoured on exactly the
	 * transition the handle's is — an object found `Suspended` going back to
	 * `Running` — and is ignored on the CREATE path, where the POST already
	 * carries the template as it stands.
	 *
	 * Omitted or `false`, an adopt behaves exactly as it always did.
	 */
	readonly refreshPodTemplate?: boolean
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

/** The `metadata.name` of each claim, in declaration order, blanks dropped. */
function volumeClaimTemplateNames(
	volumeClaimTemplates: readonly SandboxVolumeClaimTemplate[] | undefined,
): string[] {
	const names: string[] = []
	for (const entry of volumeClaimTemplates ?? []) {
		const name = entry.metadata?.name
		if (typeof name === 'string' && name !== '') names.push(name)
	}
	return names
}

/**
 * Refuse a refresh whose template declares a DIFFERENT set of disks than the
 * Sandbox it would be written onto.
 *
 * Only a refresh can arrive here, and that is the whole point. On the create
 * path the pod template and the `volumeClaimTemplates` come out of the same
 * `SandboxTemplate` in the same read, so the two sides cannot disagree. On a
 * refresh they are two different objects: `spec.volumeClaimTemplates` is
 * CEL-immutable, so it is never in the patch and stays whatever the create
 * POST froze, while `spec.podTemplate` becomes whatever the template says
 * TODAY.
 *
 * {@link assertBlockModeWorkspaceDisk} asks one half of the question — is
 * every disk this Sandbox HAS still claimed as a block device by the pod
 * template about to land. This asks the other half, which nothing else can
 * see: does the template claim a disk this Sandbox does not have. Adding a
 * second `volumeClaimTemplates` entry with its matching `volumeDevices` entry
 * is the ordinary way to give a workspace another disk, and a template edited
 * that way is internally consistent — it passes every check made against
 * itself, and every branch of the check above, because the original disk is
 * still claimed. Written onto a standing workspace it produces a pod spec
 * naming a device the Sandbox has no PVC for. The shipped workspace template
 * declares no `spec.volumes`, so there is no other source for that name: the
 * controller would be left unable to build a valid pod, the workspace would
 * sit `Running` with nothing coming up, and the caller would see a bind
 * timeout naming nothing. Recovery would mean suspending, reverting the
 * template and refreshing again — the object having been left permanently
 * describing a disk that does not exist.
 *
 * Comparing the NAMES is the whole rule, because the name is what the
 * controller wires by (StatefulSet style, `<entry name>-<sandbox name>`). An
 * edit to an existing entry's other fields — its size, its storage class,
 * its `volumeMode` — simply does not apply to a standing workspace, and is
 * not refused here: the disk it describes is the disk that is already there.
 * Only a template pointed at a workspace whose disks it cannot describe at
 * all is a mistake worth stopping.
 *
 * What neither check catches, and deliberately: a template whose containers
 * claim a `volumeDevices` name that is in NEITHER its own
 * `volumeClaimTemplates` NOR the Sandbox's. The check above asks only that
 * every disk the Sandbox HAS is still claimed, and this one asks only about
 * names the template's `volumeClaimTemplates` adds, so a device claimed out
 * of nowhere passes both. That template is equally broken on the CREATE path,
 * which has no check either and would produce the same unbuildable pod on a
 * brand-new workspace — it is a template that is wrong about itself, not a
 * template that is wrong about this workspace, and this pair of refusals is
 * only about the second kind.
 */
function assertRefreshedTemplateClaimsTheSameDisks(
	source: string,
	templateVolumeClaimTemplates: readonly SandboxVolumeClaimTemplate[] | undefined,
	sandboxVolumeClaimTemplates: readonly SandboxVolumeClaimTemplate[] | undefined,
): void {
	const wanted = volumeClaimTemplateNames(templateVolumeClaimTemplates)
	const held = new Set(volumeClaimTemplateNames(sandboxVolumeClaimTemplates))
	const extra = wanted.filter((name) => !held.has(name))
	if (extra.length === 0) return
	throw new KubernetesWorkspaceDiskError(
		source,
		`kubernetes: ${source} declares the volumeClaimTemplate${extra.length === 1 ? '' : 's'} ${extra.map((name) => JSON.stringify(name)).join(', ')}, which this workspace's Sandbox does not have — it was created with ${[...held].map((name) => JSON.stringify(name)).join(', ') || 'none'} and spec.volumeClaimTemplates is CEL-immutable, so no refresh can add a disk to a workspace that already exists. Writing this template's pod spec onto it would claim a device node backed by no PVC, and the controller would never build a valid pod. Refresh this workspace against a template that declares the disks it already has, or create a new workspace from this template and migrate the data.`,
	)
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
 *
 * The PROFILE check is conditional, because a profile is what this
 * configuration asks for rather than something every object has: it runs when
 * `config.egress.profile` is set, and then the object's own pod template has
 * to carry that key with that value — unless this call is about to REWRITE
 * that pod template (`refreshPodTemplate: true` onto a Suspended object),
 * which writes the configured profile with the rest of the overlays. That is
 * the same lifting the `runtimeClassName` check gets, for the same reason and
 * with the same re-application if the patch does not land.
 *
 * Both halves of the policy selector are therefore checked against the object
 * on this path — which matters because neither network check further up can
 * do it: the ingress verification and the egress union both run against the
 * labels the POST *would* stamp, and on this path the POST already lost to a
 * 409. What this does NOT check is a
 * label the standing object carries that this configuration does not ask for
 * — an object built under a profile this config has dropped, say. That pod is
 * still selected by the unprofiled policy this call verified (a selector is a
 * subset match), so the boundary it reports holds; what a stale label could
 * do is bring a SECOND policy into the union, and the adopt path cannot
 * enumerate the standing object's labels without reading them, which is a
 * wider change than this refusal.
 */
export function assertAdoptedWorkspaceMatchesConfig(
	sandboxName: string,
	namespace: string,
	podTemplate: SandboxPodTemplate | undefined,
	expected: {
		readonly sandboxTemplateName: string
		readonly profile?: EgressProfileLabel
		readonly runtimeClassName?: string
	},
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
	const profile = expected.profile
	if (profile !== undefined) {
		const carried = podTemplate?.metadata?.labels?.[profile.key]
		if (carried !== profile.value) {
			throw new KubernetesWorkspaceMismatchError(
				sandboxName,
				'egressProfile',
				`${profile.key}=${profile.value}`,
				carried === undefined ? undefined : `${profile.key}=${carried}`,
				`kubernetes: Sandbox ${sandboxName} in namespace ${namespace} already exists, and its spec.podTemplate carries ${profile.key}: ${carried === undefined ? '(absent)' : JSON.stringify(carried)} rather than the configured egress profile ${JSON.stringify(profile.value)}. The translated policy's podSelector matches that label as well as the template one, so this object's pod is not selected by the policy this call just verified — and since each profile needs its own policy object, a pod carrying no profile label at all is selected by none of them, while create() would have reported the boundary verified. A standing workspace's pod labels are not rewritten underneath it by an ordinary adopt, so the mismatch is named instead. Three ways out, and only the last one costs the disk: reopen it with refreshPodTemplate: true, which rewrites spec.podTemplate — profile label and all — on the one Suspended → Running transition and is the supported way to move a workspace between profiles; or point config.egress.profile at ${carried === undefined ? 'the profile this object was built under (none was)' : JSON.stringify(carried)}; or delete the Sandbox — which takes its disk with it — and create it again under ${JSON.stringify(profile.value)}.`,
			)
		}
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
	const agentAddress = config.agentAddress ?? 'service'
	// Resolved before anything is POSTed, so a configuration this backend
	// will never honour is refused rather than leaving an object behind.
	const streamHeartbeatMs = resolveStreamHeartbeatMs(config.streamHeartbeatMs)
	const epoch = assertHolderEpoch(options.epoch, 'createKubernetesWorkspace')
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))

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
	// once-per-backend check is: the boundary object is built per create here,
	// so both of its memos live exactly as long as this call — creating a
	// workspace is a rare, explicit act with nothing to amortise, and a policy
	// deleted since the last call has to be noticed. The union half runs
	// further down, against the labels the POST is about to stamp — the pod's
	// own labels on the create path. On the ADOPT path the POST loses to a
	// 409 and those labels are not the standing pod's, so the two a policy
	// selector is built from, the template label and the profile, are checked
	// against the standing object itself instead: see
	// `assertAdoptedWorkspaceMatchesConfig`.
	//
	// Before the boundary is built, because building it resolves the profile:
	// a profile this backend would never emit is a wiring error, and it reads
	// as one when it is refused in its own words rather than out of a policy
	// name.
	assertEgressProfileIsUsable(config.egress)
	const egressBoundary = buildEgressBoundary(client, config, templateName)
	if (config.egress) {
		assertEgressPolicyIsEnforceable(
			config.egress.policy,
			config.egress.engine ?? 'core',
			config.egress.ciliumNarrowing,
		)
		await egressBoundary?.verifyNamedObject(options.signal)
	}

	// Read and validate BEFORE anything is created, so a template that cannot
	// carry a workspace fails with nothing to clean up.
	const template = await readSandboxTemplate(client, namespace, templateName, options.signal)
	assertBlockModeWorkspaceDisk(
		`SandboxTemplate ${templateName} in namespace ${namespace}`,
		template.podTemplate,
		template.volumeClaimTemplates,
	)

	// And the other half of the boundary the egress block above calls
	// primary: an ingress policy that actually closes the agent port on the
	// labels this pod will carry. Checked before the POST, so a refusal leaves
	// no Sandbox and no PVC behind — and, on the adopt path, sends no resume
	// patch: a workspace whose port stopped being covered is refused asleep
	// rather than woken up to be refused. `sandboxPodLabels` is the same function the
	// create body stamps its labels with, so the check cannot verify a pod
	// nobody creates. Not memoized, for the reason the egress check above is
	// not: this is a rare, explicit act with nothing to amortise, and a policy
	// deleted since the last call has to be noticed.
	// A workspace is a Sandbox this backend POSTs directly, so an egress
	// PROFILE has to be stamped by this body rather than merged by the
	// controller — and the same map has to reach both the check below and the
	// POST further down, or the check would verify a pod nobody creates. One
	// composer, one call, both call sites. A workspace ADOPTED from a previous
	// create keeps the pod labels it was created with — an ordinary adopt
	// patches no pod template — so the adopt below REFUSES an object whose
	// profile label is not the configured one rather than handing back a pod
	// the verified policy does not select. The way to move an existing
	// workspace onto a new profile is `refreshPodTemplate: true`, which
	// rewrites `/spec/podTemplate` with exactly these labels.
	const profile = egressProfileLabel(config.egress)
	const profilePodLabels = composeAdditionalPodLabels(config.egress)
	const workspacePodLabels = sandboxPodLabels(template, templateName, profilePodLabels)
	const workspaceSubject = `to open workspace ${options.workspaceId} as Sandbox ${name} in namespace ${namespace}`
	const verifyIngress = buildIngressVerifier(client, config)
	if (verifyIngress !== undefined) {
		await verifyIngress(workspacePodLabels, workspaceSubject, options.signal)
	}
	// And the egress half of the same question, against the same labels: the
	// named object matching exactly says nothing about what a SECOND policy
	// selecting these pods lets out, and a long-lived workspace is the sandbox
	// most likely to be pointed at a network. Checked before the POST for the
	// reason the ingress check is, and on the adopt path before any resume
	// patch — a workspace whose egress stopped being bounded is refused asleep
	// rather than woken up to be refused.
	await egressBoundary?.verifyUnion(workspacePodLabels, workspaceSubject, options.signal)

	// The pod template this call would write, and its revision — built once,
	// from the same overlays `buildSandboxBody` applies below, because the
	// hash has to be taken over exactly the object that lands on the cluster.
	// `profilePodLabels` is one of those overlays: a refresh rewrites
	// `/spec/podTemplate` WHOLE, so one built without them would PATCH the
	// profile label off a workspace that carries it, and the revision stamped
	// by the POST would be taken over a template the POST never wrote.
	const refresh = buildPodTemplateRefresh(
		template,
		templateName,
		config.runtimeClassName,
		profilePodLabels,
	)

	let adopted: AdoptedWorkspace | undefined
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
				podLabels: profilePodLabels,
				// Stamped by the POST itself rather than by a patch after it,
				// so a workspace created under an epoch is fenced from the
				// moment it exists — there is no window in which the object
				// stands unfenced and a second opener could take it. The
				// pod-template revision rides along for the same reason: an
				// object that recorded what it was built from on its second
				// request would have a window in which it claimed none.
				annotations: {
					...(epoch !== undefined ? { [HOLDER_EPOCH_ANNOTATION_KEY]: String(epoch) } : {}),
					[POD_TEMPLATE_HASH_ANNOTATION_KEY]: refresh.hash,
				},
				...(config.runtimeClassName !== undefined
					? { runtimeClassName: config.runtimeClassName }
					: {}),
			}),
			options.signal,
		)
	} catch (err) {
		if (!(err instanceof KubernetesConflictError)) throw err
		adopted = await adoptExistingWorkspace(
			client,
			namespace,
			name,
			options.workspaceId,
			{
				sandboxTemplateName: templateName,
				// The same resolution the create body and the policy selector
				// were built from, so the object is checked against exactly
				// the label this call would have stamped.
				...(profile !== undefined ? { profile } : {}),
				...(config.runtimeClassName !== undefined
					? { runtimeClassName: config.runtimeClassName }
					: {}),
			},
			epoch,
			options.refreshPodTemplate === true ? refresh : undefined,
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
		agentAddress,
		streamHeartbeatMs,
		readiness,
		origin: adopted === undefined ? 'created' : adopted.resumed ? 'resumed' : 'adopted-running',
		sandboxTemplateName: templateName,
		...(config.runtimeClassName !== undefined ? { runtimeClassName: config.runtimeClassName } : {}),
		// Carried for the reason the template name and the RuntimeClass are:
		// a `resume({ refreshPodTemplate: true })` rebuilds the pod template
		// long after this call, and a refresh rebuilt without these labels
		// would patch the egress profile off the very pod the configured
		// policy selects.
		...(Object.keys(profilePodLabels).length > 0 ? { podLabels: profilePodLabels } : {}),
		// A create wrote the revision it just computed; an adopt reports
		// whatever the standing object carries, which is `undefined` for one
		// created before the annotation existed.
		...(adopted === undefined
			? { templateRevision: refresh.hash }
			: adopted.templateRevision !== undefined
				? { templateRevision: adopted.templateRevision }
				: {}),
		currentTemplateHash: refresh.hash,
		...(adopted?.awaitReplacement === true ? { awaitReplacement: true } : {}),
		...(epoch !== undefined ? { epoch } : {}),
		...(adopted?.drainingPodUid !== undefined ? { drainingPodUid: adopted.drainingPodUid } : {}),
		...(options.onStartFailure !== undefined ? { onStartFailure: options.onStartFailure } : {}),
		...(options.onCancellationUnconfirmed !== undefined
			? { onCancellationUnconfirmed: options.onCancellationUnconfirmed }
			: {}),
		...(options.onQuiesceUnsupported !== undefined
			? { onQuiesceUnsupported: options.onQuiesceUnsupported }
			: {}),
		...(options.onQuiesceNarrowed !== undefined
			? { onQuiesceNarrowed: options.onQuiesceNarrowed }
			: {}),
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
 * last month's configuration, decided the shape of. The silent losses are the
 * template label, the egress profile label when one is configured, and the
 * RuntimeClass — see {@link KubernetesWorkspaceMismatchError}.
 *
 * The refusals all happen BEFORE the resume patch: an object this call will
 * not use is not woken up on the way to being rejected.
 *
 * What it OBSERVES, and hands back, is whether the pod this workspace is
 * about to be bound to is a pod that already exists. Both answers here mean
 * it is not: an object found `Suspended` has had its pod taken away, and a
 * pod already carrying a `deletionTimestamp` is one the controller is in the
 * middle of taking away. Either way the pod this handle will serve has not
 * been created yet, and the first bind attempt has to WAIT for it rather than
 * fail on the read that finds no live pod — see {@link PodBindPolicy}.
 */
async function adoptExistingWorkspace(
	client: KubernetesClient,
	namespace: string,
	name: string,
	workspaceId: string,
	expected: {
		readonly sandboxTemplateName: string
		readonly profile?: EgressProfileLabel
		readonly runtimeClassName?: string
	},
	epoch: number | undefined,
	refresh: PodTemplateRefresh | undefined,
	signal?: AbortSignal,
): Promise<AdoptedWorkspace> {
	const target: WorkspaceWriteTarget = { client, namespace, name, workspaceId }
	const existing = await readSandboxObject(target, signal)
	assertBlockModeWorkspaceDisk(
		`Sandbox ${name} in namespace ${namespace}`,
		existing?.spec?.podTemplate,
		existing?.spec?.volumeClaimTemplates,
	)
	const suspended = operatingModeOf(existing) === 'Suspended'
	// A refresh is a Suspended→Running write and nothing else, so an object
	// found Running is adopted exactly as it always was — see
	// {@link KubernetesWorkspaceTransitionOptions.refreshPodTemplate}.
	const refreshing = refresh !== undefined && suspended
	assertAdoptedWorkspaceMatchesConfig(name, namespace, existing?.spec?.podTemplate, {
		sandboxTemplateName: expected.sandboxTemplateName,
		// The RuntimeClass and egress-profile refusals are lifted for a call
		// that is ABOUT TO WRITE them, and only for as long as that stays
		// true: if the patch below does not land, both are re-applied against
		// the object as it then stands, so a pod on the wrong runtime — or
		// under a profile no policy selects — is never bound. They are lifted
		// together because a refresh writes them together: the patched pod
		// template is `sandboxPodTemplate`'s, overlays and all, so the
		// profile label lands with the class. The TEMPLATE refusal is never
		// lifted — a refresh rewrites a workspace's pod spec, it never moves
		// the workspace to another template.
		...(refreshing
			? {}
			: {
					...(expected.profile !== undefined ? { profile: expected.profile } : {}),
					...(expected.runtimeClassName !== undefined
						? { runtimeClassName: expected.runtimeClassName }
						: {}),
				}),
	})
	const reading = readHolderEpoch(existing?.metadata)
	// With the adopt's other refusals, and for the same reason: an object this
	// call will not use is not woken up on the way to being rejected. A
	// superseded opener patches nothing and starts no pod.
	if (epoch !== undefined)
		assertHolderEpochAllows(target, 'createKubernetesWorkspace', epoch, reading)
	if (refreshing && refresh !== undefined) {
		// Both BEFORE the patch, and both against the SANDBOX's
		// volumeClaimTemplates rather than the template's: those are
		// CEL-immutable and are not in the patch, so the disks a refresh can
		// be applied to are the disks this workspace already has, and the two
		// questions worth asking are whether the template still claims them
		// and whether it claims anything else.
		const source = `SandboxTemplate ${expected.sandboxTemplateName} in namespace ${namespace}, refreshing Sandbox ${name}`
		assertRefreshedTemplateClaimsTheSameDisks(
			source,
			refresh.volumeClaimTemplates,
			existing?.spec?.volumeClaimTemplates,
		)
		// A template that stopped claiming this workspace's disk would come up
		// healthy with the disk attached to nothing, and the only symptom
		// would be that yesterday's files are gone.
		assertBlockModeWorkspaceDisk(source, refresh.podTemplate, existing?.spec?.volumeClaimTemplates)
	}
	let templateRevision = readPodTemplateHash(existing?.metadata)
	// Read BEFORE the resume patch, so what is recorded is the state this
	// adopt WALKED INTO rather than one it provoked. It costs one GET on a
	// path that is a rare, explicit act with nothing to amortise — the same
	// trade the egress verification above makes — and it buys the one fact
	// nothing else on this path can supply: whether the pod standing under
	// this name is on its way out.
	const drainingPodUid = await readDrainingPodUid(client, namespace, name, signal)
	let resumed = suspended
	/** Somebody else's resume beat this call's patch — see `awaitReplacement`. */
	let racedResume = false
	if (refreshing && refresh !== undefined) {
		const result = await writeRefreshedPodTemplate(
			target,
			'createKubernetesWorkspace',
			refresh,
			epoch,
			reading,
			signal,
		)
		if (result.applied) {
			templateRevision = refresh.hash
		} else {
			// Another process resumed it first: nothing was written, so this
			// is an adopt of a Running object and behaves like one — the
			// RuntimeClass refusal applies again, against the object as it
			// now stands, and the pod that is there is bound unchanged.
			resumed = false
			racedResume = true
			assertAdoptedWorkspaceMatchesConfig(
				name,
				namespace,
				result.sandbox.spec?.podTemplate,
				expected,
			)
			templateRevision = readPodTemplateHash(result.sandbox.metadata)
			if (epoch !== undefined) {
				await writeOperatingMode(
					target,
					'createKubernetesWorkspace',
					undefined,
					epoch,
					signal,
					readHolderEpoch(result.sandbox.metadata),
				)
			}
		}
	} else if (resumed) {
		await writeOperatingMode(target, 'createKubernetesWorkspace', 'Running', epoch, signal, reading)
	} else if (epoch !== undefined) {
		// The one write this path did not use to make. Adopting a RUNNING
		// workspace sent nothing at all, which is precisely what left race 1
		// open: the new holder took the workspace over and left no trace on
		// the object, so a superseded holder's later suspend had nothing to
		// be refused by. Taking a workspace over is the moment the fence
		// moves, whether or not the mode moves with it.
		await writeOperatingMode(target, 'createKubernetesWorkspace', undefined, epoch, signal, reading)
	}
	return {
		resumed,
		...(templateRevision !== undefined ? { templateRevision } : {}),
		...(racedResume ? { awaitReplacement: true } : {}),
		...(drainingPodUid !== undefined ? { drainingPodUid } : {}),
	}
}

/** What an adopt found standing under the workspace's name. */
interface AdoptedWorkspace {
	/** The object was `Suspended`, and this call patched it back to Running. */
	readonly resumed: boolean
	/**
	 * The pod-template revision the adopted object carries, AFTER this call's
	 * refresh if one landed — see
	 * {@link KubernetesWorkspace.templateRevision}. Absent on an object
	 * created before the annotation existed.
	 */
	readonly templateRevision?: string
	/**
	 * The object was observed `Suspended` and ANOTHER process resumed it
	 * before this call's conditional patch landed.
	 *
	 * It is not `resumed` — this call patched nothing and did not author the
	 * transition — but a replacement pod is on its way in exactly as it would
	 * be if it had, so the first bind has to WAIT rather than fail on a read
	 * that finds no live pod. That is the rule
	 * {@link PodBindPolicy.awaitReplacement} already states for an object that
	 * was suspended; without this the authorship and the waiting would be one
	 * field, and losing the race would cost the workspace its bind.
	 */
	readonly awaitReplacement?: boolean
	/**
	 * The uid of a pod that was ALREADY terminating when the adopt looked —
	 * `deletionTimestamp` set, container still running.
	 *
	 * That pod is never bound to: its uid is the agent's bind token and the
	 * replacement agent refuses it. Recording it is what lets the first bind
	 * exclude it by name in the failure message, exactly as a resume names
	 * the pod its own suspend patch retired.
	 */
	readonly drainingPodUid?: string
}

/**
 * The uid of the pod standing under this Sandbox's name IF it is draining,
 * and `undefined` for every other answer — no pod, or a pod that is fine.
 *
 * One GET by the Sandbox's name, the same convention
 * {@link readBoundPod}'s fast path uses: the pod is named after its
 * Sandbox in the controller this backend targets. No selector fallback,
 * because the cost of missing a draining pod here is one adopt that fails the
 * way it does today rather than a wrong answer, while a list on every adopt
 * is a round trip paid by every caller for a state most of them are not in.
 *
 * A 404 is "no pod", which is the ordinary answer on a suspended workspace.
 * Anything else is rethrown: a host that cannot read pods cannot read a bind
 * token either, and hearing it here names the real problem.
 */
async function readDrainingPodUid(
	client: KubernetesClient,
	namespace: string,
	name: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	let pod: PodResource | undefined
	try {
		pod = await client.request<PodResource>('GET', podPath(namespace, name), undefined, signal)
	} catch (err) {
		if (err instanceof KubernetesAlreadyGoneError) return undefined
		throw err
	}
	// `!= null` for the same reason `isPodLive` uses it: an explicit JSON null
	// must not read as "terminating".
	if (pod?.metadata?.deletionTimestamp == null) return undefined
	const uid = pod.metadata.uid
	return typeof uid === 'string' && uid !== '' ? uid : undefined
}

/**
 * The UNFENCED operating-mode merge patch — what this module sends when a
 * call carries no holder epoch, which is every call that carried none before
 * epochs existed, byte for byte and content type included. The fenced form is
 * `objects.ts`'s `buildHolderEpochPatch`; both go out through
 * {@link writeOperatingMode} and nothing else builds either.
 *
 * Built per call rather than held as constants because each one stamps
 * {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY} with the moment it was
 * sent. That annotation is what
 * {@link listKubernetesWorkspaces} reports as `operatingModeChangedAt`, and
 * the patch is the only place the fact exists: the controller's `Suspended`
 * condition lingers True across a resume, so neither its presence nor its
 * `lastTransitionTime` can be read as "when did this change" — see the
 * annotation's own comment.
 *
 * The body stays otherwise minimal, and a JSON merge patch (RFC 7386, which
 * is what `k8s-client.ts` sends) recurses into `metadata.annotations` rather
 * than replacing the map, so a Sandbox carrying annotations somebody else put
 * there keeps them.
 */
function operatingModePatch(mode: 'Running' | 'Suspended'): Record<string, unknown> {
	return {
		metadata: {
			annotations: { [OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY]: new Date().toISOString() },
		},
		spec: { operatingMode: mode },
	}
}

/**
 * How many times one fenced write may be re-read and re-sent before it gives
 * up.
 *
 * A failed `test` is only worth retrying when the value the patch tested has
 * actually MOVED, and the loop checks that on every attempt (see
 * {@link writeOperatingMode}), so this is not a "retry until it works" budget
 * — it is the ceiling on how many times a workspace may legitimately change
 * underneath one call. Three is one more than the case that really happens: a
 * controller status write moving `resourceVersion` between the read and the
 * write of a workspace that carries no epoch annotation yet, which needs one
 * re-read and then succeeds.
 */
const HOLDER_EPOCH_WRITE_ATTEMPTS = 3

/** Everything a fenced write needs to address, and to name in a refusal. */
interface WorkspaceWriteTarget {
	readonly client: KubernetesClient
	readonly namespace: string
	readonly name: string
	readonly workspaceId: string
}

/** One GET of the Sandbox, which is where every condition is read from. */
async function readSandboxObject(
	target: WorkspaceWriteTarget,
	signal?: AbortSignal,
): Promise<SandboxResource | undefined> {
	return await target.client.request<SandboxResource>(
		'GET',
		sandboxPath(target.namespace, target.name),
		undefined,
		signal,
	)
}

/** `spec.operatingMode`, with the CRD's own default for an absent one. */
function operatingModeOf(sandbox: SandboxResource | undefined): 'Running' | 'Suspended' {
	return sandbox?.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running'
}

/** Refuse a write the stored epoch has moved past. Changes nothing anywhere. */
function assertHolderEpochAllows(
	target: WorkspaceWriteTarget,
	operation: string,
	epoch: number,
	reading: HolderEpochReading,
): void {
	if (holderEpochAllows(reading, epoch)) return
	throw new KubernetesWorkspacePreconditionError(
		operation,
		target.workspaceId,
		target.name,
		epoch,
		reading.epoch,
		reading.annotation,
	)
}

/**
 * Read the object and refuse the write if this caller has been superseded,
 * BEFORE the caller does anything it cannot undo.
 *
 * The refusal it raises is the same one the write itself would raise; what
 * this buys is WHEN. `suspend()` kills every terminal it handed out and
 * `destroy()` tears its session down, both before any request goes out, so a
 * superseded holder that found out from the write would have taken its own
 * caller's sessions away on a write that never applied. The reading it hands
 * back is then used as the first attempt's condition, so the gate costs no
 * extra round trip.
 *
 * With no epoch there is nothing to check and nothing is read: the request
 * log of an unfenced call is what it always was.
 */
async function readHolderEpochGate(
	target: WorkspaceWriteTarget,
	operation: string,
	epoch: number | undefined,
	signal?: AbortSignal,
): Promise<HolderEpochReading | undefined> {
	if (epoch === undefined) return undefined
	const reading = readHolderEpoch((await readSandboxObject(target, signal))?.metadata)
	assertHolderEpochAllows(target, operation, epoch, reading)
	return reading
}

/**
 * The single send path for every `spec.operatingMode` write this backend
 * makes, fenced or not.
 *
 * Unfenced (`epoch === undefined`) it sends the merge patch it always sent,
 * content type included, and a `mode` of `undefined` sends nothing at all —
 * there is no such thing as an unfenced write with no mutation in it.
 *
 * Fenced, it is one request: {@link buildHolderEpochPatch} puts the `test`
 * and the mutation in the same body, so nothing can fit between them. The
 * loop around it is NOT a retry-until-it-works — the API server answers every
 * unapplied JSON patch with the same opaque 422 whether the `test` failed or
 * the body was wrong (see {@link KubernetesPatchNotAppliedError}), so the
 * only honest way to tell them apart is to look: re-read the object, and if
 * the value this patch tested is still exactly what it tested, the patch did
 * not lose a race and is simply wrong, so the error stands. If it HAS moved,
 * the new reading is checked against this call's epoch like any other — a
 * holder that overtook this one is refused, and a controller status write
 * that only moved `resourceVersion` is retried on the fresh read.
 *
 * `mode` omitted with an epoch present is the stamp-only write: take the
 * workspace over without changing what it is doing. It deliberately does not
 * stamp {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY} — the mode did not
 * change, and that annotation is an inventory column that has to stay true.
 */
async function writeOperatingMode(
	target: WorkspaceWriteTarget,
	operation: string,
	mode: 'Running' | 'Suspended' | undefined,
	epoch: number | undefined,
	signal?: AbortSignal,
	gate?: HolderEpochReading,
): Promise<void> {
	const path = sandboxPath(target.namespace, target.name)
	if (epoch === undefined) {
		if (mode === undefined) return
		await target.client.request('PATCH', path, operatingModePatch(mode), signal)
		return
	}
	let reading = gate ?? readHolderEpoch((await readSandboxObject(target, signal))?.metadata)
	for (let attempt = 1; ; attempt += 1) {
		assertHolderEpochAllows(target, operation, epoch, reading)
		const patch = buildHolderEpochPatch({
			reading,
			epoch,
			...(mode !== undefined
				? { operatingMode: mode, operatingModeChangedAt: new Date().toISOString() }
				: {}),
		})
		try {
			await target.client.request('PATCH', path, patch, signal, 'json')
			return
		} catch (err) {
			if (!(err instanceof KubernetesPatchNotAppliedError)) throw err
			if (attempt >= HOLDER_EPOCH_WRITE_ATTEMPTS) throw err
			const next = readHolderEpoch((await readSandboxObject(target, signal))?.metadata)
			const unmoved =
				next.annotation === reading.annotation &&
				next.resourceVersion === reading.resourceVersion &&
				next.hasAnnotations === reading.hasAnnotations
			if (unmoved) throw err
			reading = next
		}
	}
}

/**
 * The pod template a refresh would write, and the revision it stamps beside
 * it.
 *
 * Built once per call and carried as a pair on purpose: the hash is taken
 * over the template AFTER this backend's overlays, so computing it anywhere
 * but next to the object it describes is how `templateCurrent` starts
 * reporting drift that does not exist.
 */
interface PodTemplateRefresh {
	readonly podTemplate: SandboxPodTemplate
	readonly hash: string
	/**
	 * The disks the template declares. Never written — they are CEL-immutable
	 * on a standing Sandbox and are not in the patch — and carried only so
	 * {@link assertRefreshedTemplateClaimsTheSameDisks} can refuse a template
	 * whose disks this workspace cannot have.
	 */
	readonly volumeClaimTemplates?: readonly SandboxVolumeClaimTemplate[]
}

/**
 * The overlays of `buildSandboxBody`'s create body, plus their revision.
 *
 * `podLabels` is `composeAdditionalPodLabels`'s map — the egress profile
 * today — and it is an overlay like the other two rather than an extra: the
 * patch this feeds replaces `/spec/podTemplate` whole, so a refresh that left
 * it out would REMOVE the profile label from a workspace created with it. The
 * replacement pod would come up selected by no per-profile policy, on a path
 * where nothing re-reads the label, and the hash would disagree with what
 * every create POSTs, so `templateCurrent` would report drift that no refresh
 * could clear.
 */
function buildPodTemplateRefresh(
	template: SandboxTemplateCopy,
	sandboxTemplateName: string,
	runtimeClassName?: string,
	podLabels?: Readonly<Record<string, string>>,
): PodTemplateRefresh {
	const podTemplate = sandboxPodTemplate(template, sandboxTemplateName, runtimeClassName, podLabels)
	return {
		podTemplate,
		hash: podTemplateHash(podTemplate),
		...(template.volumeClaimTemplates !== undefined
			? { volumeClaimTemplates: template.volumeClaimTemplates }
			: {}),
	}
}

/**
 * What one refresh attempt settled on.
 *
 * `applied: false` is not a failure: the `test` clause found the workspace
 * already `Running`, which means another process resumed it first and the pod
 * standing under this name is theirs. Nothing was written, the caller binds
 * that pod unchanged, and `sandbox` is the object as re-read so the refusals
 * an adopt of a Running object makes can be made against it without a second
 * GET.
 *
 * `sandbox` is therefore never `undefined`: an object that is GONE by the time
 * of that re-read is not this outcome at all, and the type is what says so.
 */
type PodTemplateRefreshResult =
	| { readonly applied: true }
	| { readonly applied: false; readonly sandbox: SandboxResource }

/**
 * The Suspended→Running write that also rewrites `spec.podTemplate`: ONE
 * conditional patch, built by the one builder this backend has.
 *
 * `test /spec/operatingMode == "Suspended"` is what enforces "only on a
 * suspended workspace" — not the read that preceded it, which another
 * process's resume can invalidate in the time it takes to send this. When the
 * caller also carries a holder epoch, that clause rides in the SAME body
 * (`buildHolderEpochPatch`'s `tests` seam), so the two conditions are one
 * request and there is no window between them.
 *
 * The discrimination is the one W8 measured and has to be repeated here
 * rather than shared with {@link writeOperatingMode}, because the two want
 * opposite things from the same 422: a real API server answers an unapplied
 * JSON patch identically whether a `test` failed or the body was malformed,
 * so the only way to tell is to re-read the object.
 *
 *  - the object is GONE ⇒ the re-read 404s and says so, and that error is
 *    what the caller hears. Neither clause can be said to have refused the
 *    patch, and there is no pod to fall back to.
 *  - the mode is no longer `Suspended` ⇒ the mode clause is what refused it.
 *    That is an outcome, not an error: report it, after checking that this
 *    caller has not ALSO been superseded, which is a refusal.
 *  - the mode is still `Suspended` and the call carries no epoch ⇒ the only
 *    condition in the body was true, so the body is what the server refused.
 *    Nothing to retry.
 *  - otherwise the epoch clause is the suspect: a stored epoch above this
 *    caller's refuses it by name, one that merely moved is retried on the
 *    fresh reading, and an object that did not move at all means the body is
 *    wrong and the error stands.
 */
async function writeRefreshedPodTemplate(
	target: WorkspaceWriteTarget,
	operation: string,
	refresh: PodTemplateRefresh,
	epoch: number | undefined,
	gate: HolderEpochReading,
	signal?: AbortSignal,
): Promise<PodTemplateRefreshResult> {
	const path = sandboxPath(target.namespace, target.name)
	let reading = gate
	for (let attempt = 1; ; attempt += 1) {
		if (epoch !== undefined) assertHolderEpochAllows(target, operation, epoch, reading)
		const patch = buildHolderEpochPatch({
			reading,
			...(epoch !== undefined ? { epoch } : {}),
			tests: [{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' }],
			annotations: { [POD_TEMPLATE_HASH_ANNOTATION_KEY]: refresh.hash },
			podTemplate: refresh.podTemplate,
			operatingMode: 'Running',
			operatingModeChangedAt: new Date().toISOString(),
		})
		try {
			await target.client.request('PATCH', path, patch, signal, 'json')
			return { applied: true }
		} catch (err) {
			if (!(err instanceof KubernetesPatchNotAppliedError)) throw err
			const sandbox = await readSandboxObject(target, signal)
			// An object DELETED in this window does not arrive here as
			// `undefined`: the GET 404s and `readSandboxObject` throws
			// `KubernetesAlreadyGoneError`, which is the truthful answer and is
			// let through. `undefined` is the API server answering 200 with no
			// body — a shape this code has no reading of. It must not fall
			// through, because `operatingModeOf(undefined)` is `'Running'` and
			// the branch below means "somebody else's pod is standing under
			// this name", which would send the caller on to bind a pod nothing
			// established was there, after refusals made against an object
			// nobody read. The original error says the one thing that is known
			// — the patch did not apply and nothing changed.
			if (sandbox === undefined) throw err
			const next = readHolderEpoch(sandbox.metadata)
			if (operatingModeOf(sandbox) !== 'Suspended') {
				// Somebody resumed it first. If they also took the workspace
				// over, this caller hears THAT rather than being handed a pod
				// it is no longer entitled to bind.
				if (epoch !== undefined) assertHolderEpochAllows(target, operation, epoch, next)
				return { applied: false, sandbox }
			}
			if (epoch === undefined) throw err
			if (attempt >= HOLDER_EPOCH_WRITE_ATTEMPTS) throw err
			const unmoved =
				next.annotation === reading.annotation &&
				next.resourceVersion === reading.resourceVersion &&
				next.hasAnnotations === reading.hasAnnotations
			if (unmoved) throw err
			reading = next
		}
	}
}

/**
 * DELETE the Sandbox, fenced by the epoch when the caller supplied one.
 *
 * The condition here cannot be a JSON Patch `test`, because a DELETE has no
 * patch body — so it is `preconditions.resourceVersion` on the very version
 * whose epoch was just read, which the API server answers with a 409 naming
 * both versions when it no longer matches (measured). Anything that touched
 * the object between the read and the DELETE — another holder raising the
 * epoch included — moves that version, so the DELETE is refused and re-read
 * rather than taking a disk on a stale view.
 *
 * Unfenced it is the bodyless DELETE it always was. Already gone counts as
 * deleted either way, that being the state DELETE was asking for.
 */
async function deleteSandboxObject(
	target: WorkspaceWriteTarget,
	operation: string,
	epoch: number | undefined,
	signal?: AbortSignal,
	gate?: HolderEpochReading,
): Promise<void> {
	const path = sandboxPath(target.namespace, target.name)
	if (epoch === undefined) {
		try {
			await target.client.request('DELETE', path, undefined, signal)
		} catch (err) {
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
		}
		return
	}
	let reading = gate
	for (let attempt = 1; ; attempt += 1) {
		if (reading === undefined) {
			let sandbox: SandboxResource | undefined
			try {
				sandbox = await readSandboxObject(target, signal)
			} catch (err) {
				if (err instanceof KubernetesAlreadyGoneError) return
				throw err
			}
			reading = readHolderEpoch(sandbox?.metadata)
		}
		assertHolderEpochAllows(target, operation, epoch, reading)
		if (reading.resourceVersion === undefined) {
			// Unreachable against a real API server, which sets it on every
			// object it serves — and a bodyless DELETE here would be an
			// UNFENCED delete of somebody's disk, which is the one thing this
			// path may never silently become.
			throw new Error(
				`kubernetes: cannot delete workspace ${target.workspaceId} (Sandbox ${target.name}) under holder epoch ${epoch}: the object came back with no metadata.resourceVersion, so there is no precondition to send and the DELETE would be unconditional.`,
			)
		}
		try {
			await target.client.request(
				'DELETE',
				path,
				{
					apiVersion: 'v1',
					kind: 'DeleteOptions',
					preconditions: { resourceVersion: reading.resourceVersion },
				},
				signal,
			)
			return
		} catch (err) {
			if (err instanceof KubernetesAlreadyGoneError) return
			if (!(err instanceof KubernetesConflictError)) throw err
			if (attempt >= HOLDER_EPOCH_WRITE_ATTEMPTS) throw err
			reading = undefined
		}
	}
}

/**
 * Which pod one bind attempt may settle on, and what a read that finds no
 * live pod is allowed to mean.
 *
 * Those two used to be one field: `acquireBoundPod` took the uid of the pod a
 * suspend had retired, and read "there is one" as "this is a transition, so a
 * read that finds nothing means not yet rather than failed". That is right
 * for a resume and wrong for an adopt, where the workspace can be
 * mid-transition with nothing for THIS handle to exclude — an object
 * suspended by a process that has since died has no pod at all, and nobody
 * has asked for its replacement until this call patches it back to Running.
 * The two questions are therefore separate fields, and each path sets them
 * from what it actually knows.
 */
interface PodBindPolicy {
	/** Which transition this bind belongs to. Decides the timeout's wording. */
	readonly transition: 'create' | 'adopt' | 'resume'
	/**
	 * A pod the controller has been asked to take away, and so one this bind
	 * must see REPLACED rather than bind: its uid is the agent's token, and
	 * the replacement agent refuses it. Set from a landed suspend patch on
	 * resume, and from a pod found already draining on adopt.
	 */
	readonly retiring?: string
	/**
	 * Whether a read that finds NO live pod at all is "not yet" rather than
	 * fatal.
	 *
	 * True wherever a pod is known to be on its way out or on its way in: a
	 * resume behind a landed suspend patch, and an adopt of an object that
	 * was suspended or whose pod was draining. For a stretch of each of those
	 * there is no live pod under the name at all, and {@link readBoundPod}
	 * answers that by throwing rather than returning undefined.
	 *
	 * False on create, and on an adopt of an object that was Running with a
	 * healthy pod. Nothing is being replaced there, so a pod read that fails
	 * is a failure with nothing to wait for, and polling it would spend the
	 * whole readiness budget before saying what the first answer already
	 * said.
	 */
	readonly awaitReplacement: boolean
}

/** Shared tail of every bind timeout but the resume-specific one. */
const NO_BINDABLE_POD_ADVICE =
	"A pod's uid is the agent's bind token, so a pod carrying a deletionTimestamp — or one in a terminal phase — is never bound to: its uid is a token the pod's replacement will refuse. The Ready condition cannot be waited on instead, because the controller leaves it standing across a transition. Raise readyTimeoutMs, or look at why the controller has not brought a pod up."

/**
 * True once the pod has actually stopped. The POD is asked, and nothing else
 * is consulted or believed.
 *
 * The cheap-looking alternative — the Sandbox's own `Suspended` condition —
 * is unusable, and upstream says so itself: "the controller does not
 * currently remove this condition when the Sandbox is resumed, so a stale
 * Suspended condition may linger after operatingMode returns to Running.
 * Consumers should treat Ready as the authoritative signal and not infer the
 * live operating state from the mere presence of this condition"
 * (`sandbox_types.go`). Reading it would make the second and every later
 * suspend of the same workspace return immediately, on a True left behind by
 * the previous one, while the guest was still running and still writing to
 * the caller's disk — and a `resume()` issued straight after such a false
 * suspend could bind to the pod that is about to be deleted.
 *
 * A `deletionTimestamp` is not the answer either: it is set the moment the
 * DELETE is accepted, and the container goes on running until it exits or
 * `terminationGracePeriodSeconds` expires. Gone (404) or stopped
 * ({@link isPodStopped}) — those are the only two states that mean the disk
 * is quiesced.
 */
async function isPodRetired(
	client: KubernetesClient,
	namespace: string,
	name: string,
	signal?: AbortSignal,
): Promise<boolean> {
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

/**
 * Poll {@link isPodRetired} until it answers true, or refuse with
 * {@link KubernetesWorkspaceSuspendTimeoutError}.
 *
 * At module scope, and taking its subject as arguments, because BOTH suspend
 * paths owe the caller the same wait: the handle's `suspend()`, which has a
 * session to tear down first, and {@link suspendKubernetesWorkspace}, which
 * has no handle at all. A suspend that resolved on the patch alone would
 * promise a quiesced disk it had not waited for, and that promise must not
 * depend on which entry point was used.
 */
async function awaitPodRetired(
	client: KubernetesClient,
	namespace: string,
	name: string,
	workspaceId: string,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
	signal?: AbortSignal,
): Promise<void> {
	const deadline = new OperationDeadline(
		readiness.timeoutMs,
		`kubernetes workspace ${name} suspend`,
		signal,
	)
	while (deadline.remainingMs() > 0) {
		try {
			if (
				await deadline.run(
					async (pollSignal) => await isPodRetired(client, namespace, name, pollSignal),
				)
			)
				return
			await deadline.delay(readiness.pollIntervalMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	throw new KubernetesWorkspaceSuspendTimeoutError(workspaceId, name, readiness.timeoutMs)
}

/**
 * What `spec.operatingMode` says RIGHT NOW, read off the object and nothing
 * else.
 *
 * `Running` when the field is absent, which is the CRD's own default. Every
 * Sandbox this backend creates sets it explicitly, so an absent value means
 * an object somebody else made — and the API's default for it is Running.
 */
async function readOperatingMode(
	client: KubernetesClient,
	namespace: string,
	name: string,
	signal?: AbortSignal,
): Promise<'Running' | 'Suspended'> {
	const sandbox = await client.request<SandboxResource>(
		'GET',
		sandboxPath(namespace, name),
		undefined,
		signal,
	)
	return operatingModeOf(sandbox)
}

/**
 * One workspace as an INVENTORY reads it: enough to decide what to do with
 * it, and not one field that required waking it up.
 *
 * Everything here comes off the Sandbox object itself. No pod is read, no
 * agent is dialed, and no transport exists — which is the whole point, since
 * the caller this exists for is a retention pass over workspaces that have
 * been asleep for a month and must stay asleep.
 */
export interface KubernetesWorkspaceSummary {
	/** The caller's own id — the Sandbox's name with `namzu-ws-` taken off. */
	readonly workspaceId: string
	/**
	 * `spec.operatingMode`, verbatim. NOT "is a pod running": a `Running`
	 * workspace whose pod is still being created, or has just crashed, reads
	 * `Running` here, because this is the mode the object was last asked to
	 * be in.
	 */
	readonly operatingMode: 'Running' | 'Suspended'
	/** The `SandboxTemplate` this workspace was built from — the pod label. */
	readonly template: string
	/**
	 * `metadata.creationTimestamp`, RFC 3339. Optional only because it is
	 * read off an object rather than promised by this type: the API server
	 * always sets it.
	 */
	readonly createdAt?: string
	/**
	 * When this backend last patched `spec.operatingMode`, RFC 3339 — the
	 * {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY} annotation.
	 *
	 * ABSENT on a workspace whose mode has never been changed since it was
	 * created, and on one created before this backend started stamping it.
	 * It is reported absent rather than defaulted to `createdAt`, because a
	 * retention rule that deletes "anything not touched for 30 days" must be
	 * able to tell "never suspended" from "suspended a month ago".
	 */
	readonly operatingModeChangedAt?: string
	/**
	 * The holder epoch stored on the Sandbox — see
	 * {@link HOLDER_EPOCH_ANNOTATION_KEY}.
	 *
	 * `0` on a workspace that carries no such annotation, because that is
	 * what every write compares against: a workspace nobody has fenced is
	 * held at epoch 0 and the next write of any epoch takes it. ABSENT only
	 * when the annotation is present and unreadable — not a decimal integer,
	 * which no release of this backend writes — because reporting that as 0
	 * would tell a retention pass a workspace is free when the next write
	 * against it will be refused.
	 *
	 * Reported rather than conditioned: a list sends no write, so it has
	 * nothing for an epoch to fence, and what an inventory needs is to SEE
	 * the fences it is looking at.
	 */
	readonly holderEpoch?: number
}

/**
 * Every workspace this backend owns in the namespace, WITHOUT waking one.
 *
 * The verb retention needs. Deleting a workspace nobody has resumed since
 * last month, or reporting what a namespace is holding, used to require
 * {@link createKubernetesWorkspace} — which adopts AND resumes: the inventory
 * pass would start a pod for every suspended workspace it looked at, probe
 * each one, and then have to put them all back. This issues exactly one GET
 * of the sandboxes collection and reads the objects.
 *
 * ## What counts as a workspace
 *
 * Two things together, and both are this backend's own marks:
 *
 *  - the `namzu-ws-` name prefix — {@link workspaceSandboxName}'s contract,
 *    and the only thing that makes a `workspaceId` recoverable from a
 *    Sandbox at all;
 *  - {@link SANDBOX_TEMPLATE_LABEL_KEY} on `spec.podTemplate.metadata.labels`,
 *    which says this object was built by this backend and names the template
 *    it came from.
 *
 * The filtering happens HERE rather than in a `labelSelector` on the request,
 * and the reason is where that label lives. It is a POD label — the one an
 * egress `NetworkPolicy`'s `podSelector` matches — written onto
 * `spec.podTemplate`, while a `labelSelector` on the sandboxes collection
 * matches the Sandbox's OWN `metadata.labels`, which this backend has never
 * written. Stamping a second copy up there to make a server-side selector
 * work would leave every workspace created before that change invisible to
 * this call, and an inventory that silently omits the oldest objects is worse
 * than no inventory at all — those are exactly the ones a retention pass is
 * looking for.
 *
 * ## What it never does
 *
 * No PATCH, no DELETE, no pod read, no dial. A workspace that was suspended
 * before this call is suspended after it, and a running one is untouched. The
 * order is the API server's own (name order); the caller sorts if it cares.
 */
export async function listKubernetesWorkspaces(
	config: KubernetesBackendInternalConfig,
	options?: KubernetesWorkspaceTransitionOptions,
): Promise<readonly KubernetesWorkspaceSummary[]> {
	options?.signal?.throwIfAborted()
	const namespace = config.namespace
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const list = await client.request<SandboxListResource>(
		'GET',
		sandboxCollectionPath(namespace),
		undefined,
		options?.signal,
	)
	const summaries: KubernetesWorkspaceSummary[] = []
	for (const sandbox of list?.items ?? []) {
		const name = sandbox?.metadata?.name
		if (typeof name !== 'string' || !name.startsWith(WORKSPACE_NAME_PREFIX)) continue
		const template = sandbox?.spec?.podTemplate?.metadata?.labels?.[SANDBOX_TEMPLATE_LABEL_KEY]
		if (typeof template !== 'string' || template === '') continue
		const createdAt = sandbox?.metadata?.creationTimestamp
		const changedAt = sandbox?.metadata?.annotations?.[OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY]
		const holder = readHolderEpoch(sandbox?.metadata)
		summaries.push({
			workspaceId: name.slice(WORKSPACE_NAME_PREFIX.length),
			operatingMode: operatingModeOf(sandbox),
			template,
			...(typeof createdAt === 'string' && createdAt !== '' ? { createdAt } : {}),
			...(typeof changedAt === 'string' && changedAt !== ''
				? { operatingModeChangedAt: changedAt }
				: {}),
			...(holder.epoch !== undefined ? { holderEpoch: holder.epoch } : {}),
		})
	}
	return summaries
}

/**
 * DELETE a workspace by id, without ever adopting or resuming it.
 *
 * The same thing `destroy({ deleteDisk: true })` does to the cluster — one
 * DELETE of the Sandbox, which cascades to the Pod, the Service and the PVC
 * through ownerReferences — with the same two guarantees: an object already
 * gone counts as deleted, that being the state DELETE was asking for, and a
 * DELETE that FAILS rejects and stays retryable, because nothing here records
 * a state a retry could early-return on.
 *
 * What it does NOT do is the point. Removing a month-old suspended workspace
 * through a handle meant starting a pod for it first, probing it, and then
 * deleting the pod again — compute spent, and a guest woken, purely to be
 * told to go away. The DELETE never needed any of that: the name is
 * deterministic, so the object can be addressed without being opened.
 *
 * It is not gated on the workspace being suspended, and deliberately: a
 * running workspace's DELETE takes its pod down with it, which is what
 * deleting a workspace means. A caller that wants the disk quiesced first
 * calls {@link suspendKubernetesWorkspace} and then this.
 */
export async function deleteKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options?: KubernetesWorkspaceTransitionOptions,
): Promise<void> {
	options?.signal?.throwIfAborted()
	const namespace = config.namespace
	const name = workspaceSandboxName(workspaceId)
	const epoch = assertHolderEpoch(options?.epoch, 'deleteKubernetesWorkspace')
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	// The fence reaches the standalone verbs too, and this is the one it
	// matters most on: a retention job superseded between deciding to delete a
	// workspace and calling this would otherwise take the new holder's disk,
	// and nothing brings a disk back.
	await deleteSandboxObject(
		{ client, namespace, name, workspaceId },
		'deleteKubernetesWorkspace',
		epoch,
		options?.signal,
	)
}

/**
 * Suspend a workspace by id, without ever adopting it: send the patch, then
 * wait for the pod to actually stop.
 *
 * The handle's own `suspend()` does three things — reap the terminals it
 * handed out, stop admitting calls, and patch-and-wait. Only the third is
 * about the CLUSTER, and it is the only one a process holding no handle can
 * do or needs to. So this is that third thing on its own, for the operator
 * putting somebody else's workspace to sleep.
 *
 * It resolves only once the pod is gone or in a terminal phase, for the same
 * reason the handle's does: a suspend is a promise that the disk is quiesced,
 * and the patch being accepted says only that the controller has been asked.
 * A pod that outlives `readyTimeoutMs` rejects with
 * {@link KubernetesWorkspaceSuspendTimeoutError} and the object is left
 * exactly as the patch left it — the next call patches and waits again.
 *
 * A workspace that no longer exists rejects with the client's own
 * already-gone error rather than resolving. Unlike a DELETE, this asks for a
 * state that cannot be reached: there is no object to suspend, and nothing
 * the caller believed about it holds.
 *
 * Any HANDLE another process is holding on this workspace is not told. It
 * finds out on its next call, which fails at the transport and is re-read
 * into a {@link KubernetesWorkspaceSuspendedError} — or the moment that
 * process calls `refresh()`. See {@link KubernetesWorkspace.refresh}.
 */
export async function suspendKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options?: KubernetesWorkspaceSuspendOptions,
): Promise<void> {
	options?.signal?.throwIfAborted()
	const namespace = config.namespace
	const name = workspaceSandboxName(workspaceId)
	const epoch = assertHolderEpoch(options?.epoch, 'suspendKubernetesWorkspace')
	assertNoQuiesceHere(options?.quiesce, 'suspendKubernetesWorkspace')
	const readiness = resolveKubernetesReadiness(config)
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	await writeOperatingMode(
		{ client, namespace, name, workspaceId },
		'suspendKubernetesWorkspace',
		'Suspended',
		epoch,
		options?.signal,
	)
	await awaitPodRetired(client, namespace, name, workspaceId, readiness, options?.signal)
}

interface WorkspaceHandleOptions {
	readonly client: KubernetesClient
	readonly namespace: string
	readonly name: string
	readonly workspaceId: string
	readonly rootDir: string
	readonly agentPort: number
	/** Which address each session dials — see {@link KubernetesAgentAddressMode}. */
	readonly agentAddress: KubernetesAgentAddressMode
	/**
	 * Heartbeat interval every session's terminal and TCP streams negotiate,
	 * already resolved. `0` sends none. See `resolveStreamHeartbeatMs`.
	 */
	readonly streamHeartbeatMs: number
	readonly readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number }
	/**
	 * How the object was come by. Reported as the handle's `origin`, and it
	 * decides how the FIRST bind behaves — see {@link PodBindPolicy}.
	 */
	readonly origin: KubernetesWorkspaceOrigin
	/**
	 * The template this workspace is built from, and the RuntimeClass to
	 * overlay on it — what a `resume({ refreshPodTemplate: true })` re-reads
	 * and rebuilds from. Carried on the handle because a resume happens long
	 * after the call that opened it, and re-deriving either from the backend
	 * config would let a handle refresh a workspace onto a template it was
	 * never opened against.
	 */
	readonly sandboxTemplateName: string
	readonly runtimeClassName?: string
	/**
	 * The pod labels this workspace was opened with beyond its template
	 * label — `composeAdditionalPodLabels`'s map, the egress profile today.
	 *
	 * On the handle for the same reason the two above are: a
	 * `resume({ refreshPodTemplate: true })` rebuilds `/spec/podTemplate`
	 * whole, and a rebuild without them would patch the profile label off the
	 * object, leaving the replacement pod selected by no per-profile policy
	 * with nothing on that path to notice.
	 */
	readonly podLabels?: Readonly<Record<string, string>>
	/** The revision the bound object carries — see `templateRevision`. */
	readonly templateRevision?: string
	/** The revision the template read at open would produce — see `templateCurrent`. */
	readonly currentTemplateHash: string
	/**
	 * Wait for a replacement pod although this handle's own `origin` does not
	 * imply one — see {@link AdoptedWorkspace.awaitReplacement}. The two are
	 * separate because authorship and waiting are separate questions.
	 */
	readonly awaitReplacement?: boolean
	/**
	 * A pod found already terminating when the adopt looked; never set on the
	 * created path, where there is no previous pod at all.
	 */
	readonly drainingPodUid?: string
	/**
	 * The holder epoch this handle was opened under, already validated.
	 * Absent means this handle fences nothing and sends the requests it
	 * always sent.
	 */
	readonly epoch?: number
	/** The handle's default; a transition may override it for one call. */
	readonly onStartFailure?: KubernetesWorkspaceStartFailurePolicy
	/** See {@link KubernetesWorkspaceOptions.onCancellationUnconfirmed}. */
	readonly onCancellationUnconfirmed?: (notice: KubernetesWorkspaceCancellationNotice) => void
	/** See {@link KubernetesWorkspaceOptions.onQuiesceUnsupported}. */
	readonly onQuiesceUnsupported?: (error: KubernetesQuiesceUnsupportedError) => void
	/** See {@link KubernetesWorkspaceOptions.onQuiesceNarrowed}. */
	readonly onQuiesceNarrowed?: (report: KubernetesQuiesceReport) => void
	readonly signal?: AbortSignal
}

/**
 * How long the diagnostic `healthz` after an unconfirmed cancellation may
 * take before the agent is reported `unreachable`.
 *
 * Its own clock, short, and unrelated to every other budget on the path. The
 * caller's deadline has usually already expired by the time this runs — the
 * shared controller has just spent its whole eight-second cancel-confirm
 * window — and the readiness budget is for waiting out a pod that is coming
 * up, which is not what this is asking. This asks one question of a pod that
 * is already there, and an answer that has not arrived in five seconds is
 * not going to change what the host does with it.
 */
const CANCELLATION_DIAGNOSIS_TIMEOUT_MS = 5_000

/**
 * The identity evidence gathered about one unconfirmed cancellation, keyed
 * by the error the caller is about to receive.
 *
 * A WeakMap rather than a field, because the error class belongs to the
 * shared execution controller and this is one backend's evidence ABOUT it:
 * adding a Kubernetes-shaped property to `RemoteCancellationUnknownError`
 * would put a field on the Firecracker tier's errors that nothing there can
 * ever fill. Weak, so an error nobody kept takes its entry with it.
 *
 * It is written where the diagnosis happens ({@link
 * KubernetesWorkspace.exec}'s retirement hook) and read once, where the error
 * passes back through the handle, which is the only place that can rename it.
 */
const guestGoneEvidence = new WeakMap<
	Error,
	{
		readonly evidence: KubernetesGuestEvidence
		readonly previous: KubernetesWorkspaceIdentity
		readonly current: KubernetesWorkspaceIdentity
	}
>()

/**
 * The `reason` an unconfirmed cancellation reports on a workspace — see
 * {@link SandboxRetirementObservation.reason}. Not "the patch failed": no
 * patch was attempted, and the pod is standing on purpose.
 */
const WORKSPACE_KEPT_REASON = 'workspace-kept'

/**
 * What a failing start is allowed to do, decided BEFORE the start rather
 * than after it — see {@link startSessionOrSuspend}.
 */
interface WakeRecord {
	/** This call moved `operatingMode`: it POSTed the object, or woke it. */
	readonly woke: boolean
	/** The caller's policy for this transition. */
	readonly policy: KubernetesWorkspaceStartFailurePolicy
	/**
	 * The epoch this transition is writing under, so the cleanup patch is
	 * fenced by the same authority the start was. A cleanup that suspended
	 * unconditionally would take a pod away from the holder that overtook
	 * this call while it was starting — which is the failure mode the epoch
	 * exists for, arriving through the one path nobody looks at.
	 */
	readonly epoch?: number
}

async function openWorkspaceHandle(options: WorkspaceHandleOptions): Promise<KubernetesWorkspace> {
	const { client, namespace, name, workspaceId, readiness } = options
	const id = name as SandboxId
	/** What every fenced write addresses, and what a refusal names. */
	const target: WorkspaceWriteTarget = { client, namespace, name, workspaceId }
	/**
	 * The epoch this handle writes under when a call passes none.
	 *
	 * It is the one the handle was opened with, and it moves to whatever a
	 * later call wrote under successfully — never down, because a write only
	 * succeeds when its epoch was at least the stored one. Letting it lag
	 * behind a write this handle itself made would be the worst of both:
	 * every later `suspend()` of its own would be refused by its own stamp.
	 */
	let heldEpoch = options.epoch
	/**
	 * The pod-template revision the BOUND object carries, and the one the
	 * template this handle last read would produce. Both move together on a
	 * refresh; a plain `resume()` re-reads only the first, off the `GET` it
	 * already makes.
	 */
	let templateRevision = options.templateRevision
	let currentTemplateHash = options.currentTemplateHash
	/** The handle's own policy; a transition may override it for one call. */
	const defaultStartFailure: KubernetesWorkspaceStartFailurePolicy =
		options.onStartFailure ?? 'suspend-if-woken'

	let state: WorkspaceState = 'running'
	let session: KubernetesSandboxHandle | undefined
	/**
	 * The uid of the pod `session` is bound to — the agent's token, and the
	 * only way a resume can tell the pod it is waiting for from the one it is
	 * replacing. Read once per session and never carried across one.
	 */
	let podUid: string | undefined
	/**
	 * Which session `podUid` belongs to. Bumped when a session starts AND
	 * when one is dropped ({@link dropSession}), so the number identifies the
	 * LIVE session and nothing else — a transport whose session has been
	 * retired never matches it again. Read by {@link refreshBoundPod}, which
	 * is where the desync it prevents is described, and by
	 * {@link boundToPod}.
	 */
	let sessionSeq = 0
	/**
	 * The session `podUid` was written for — see {@link boundToPod}.
	 *
	 * Deliberately NOT `sessionSeq` itself: a dropped session bumps that
	 * counter and writes nothing else, so "the pod belongs to the session
	 * that is live" is a comparison rather than a flag anybody has to
	 * remember to clear. It starts before the first session so that a handle
	 * which has not bound anything yet is bound to nothing.
	 */
	let podSession = -1
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
	/**
	 * The Sandbox object this handle was opened on, and the disks behind it.
	 *
	 * `sandboxUid` is taken from the readiness GET the first bind already
	 * makes — the object was read, its uid was in the reply, and until now it
	 * was thrown away. It is what a rebind compares against: the workspace
	 * name is DETERMINISTIC, so an object deleted and recreated stands under
	 * the same name with an empty disk, and following a pod behind a
	 * different uid would hand a caller a stranger's workspace.
	 *
	 * `volumeClaimUids` is read ONCE, at the first bind, and not again. The
	 * PVCs belong to the Sandbox: while `sandboxUid` has not moved they have
	 * not either, so re-reading them on every resume would be a GET per
	 * volume per transition for an answer that cannot have changed. It stays
	 * empty when the Role does not grant `get` on `persistentvolumeclaims` —
	 * an existing deployment upgrading into this release must not have every
	 * `createKubernetesWorkspace` start failing on a verb its Role has never
	 * had.
	 */
	let sandboxUid: string | undefined
	let volumeClaimUids: Record<string, string> = {}
	let volumeClaimsRead = false
	/**
	 * The agent PROCESS the handle is talking to: the boot id of the last
	 * reply that carried one.
	 *
	 * Cleared whenever the pod changes — a session start, and a rebind that
	 * followed a replacement — which is what keeps the caller's own
	 * `suspend()`/`resume()` from being reported as a restart: the new pod's
	 * first reply establishes a baseline instead of being compared against
	 * the old pod's.
	 *
	 * It is deliberately NOT a baseline for the cancellation diagnosis.
	 * Whether the guest a COMMAND was running in is gone is a question about
	 * that command, and the boot id it reserved against is kept per execution
	 * by the transport ({@link guestBootIdWhenReserved}); a handle-wide
	 * baseline would answer "restarted" for every command started after a
	 * restart the handle survived.
	 *
	 * Against a guest too old to report one it stays `undefined` for ever,
	 * and nothing here fires. That is the interop contract: a missing boot id
	 * is "this guest cannot tell me", never "it changed".
	 */
	let guestBootId: string | undefined
	/** Subscribers to {@link KubernetesWorkspace.onGuestRestart}. */
	const restartListeners = new Set<(event: KubernetesGuestRestart) => void>()
	const terminals = new Set<KubernetesWorkspaceTerminal>()

	/**
	 * This handle's disk, around ONE named pod and the process inside it.
	 *
	 * Every identity this file hands out is built here, which is what keeps a
	 * payload from being blanked by a state the handle happens to be in: a
	 * routine that is HOLDING a pod uid reports that uid, and the only
	 * question left is which pod it holds.
	 */
	const identityOn = (
		pod: string | undefined,
		boot: string | undefined,
	): KubernetesWorkspaceIdentity => ({
		sandboxUid,
		volumeClaimUids: { ...volumeClaimUids },
		podUid: pod,
		guestBootId: boot,
	})

	/**
	 * Whether `podUid` still names the pod this handle is TALKING to.
	 *
	 * The question is about the SESSION and never about `state`, and the
	 * difference is not academic: a transition is not the absence of a pod.
	 * {@link startSession} binds one, records it and runs the privilege probe
	 * against it while `state` is still `'suspended'`, so a handle that
	 * answered "no pod" for the length of a resume would blank exactly the
	 * announcement this backend exists to make — a pod somebody else replaced
	 * underneath a resume, discovered when that probe is refused.
	 *
	 * Every path that gives a pod back drops the session first
	 * ({@link dropSession}), which bumps `sessionSeq` and leaves this false;
	 * every path that takes one binds through `startSession`, which sets both
	 * together. So there is no window in which this says yes about a pod
	 * nothing is talking to.
	 */
	const boundToPod = (): boolean => podUid !== undefined && podSession === sessionSeq

	/** This handle's four objects, read fresh — see {@link KubernetesWorkspaceIdentity}. */
	const identityNow = (): KubernetesWorkspaceIdentity =>
		// A handle with no session has no pod and so no agent process.
		// Reporting the ones it HAD would be the single most misleading thing
		// this object could say: the pod is deleted and those ids name nothing.
		boundToPod() ? identityOn(podUid, guestBootId) : identityOn(undefined, undefined)

	/**
	 * This handle's identity with the pod a LOOK actually FOUND, naming an
	 * agent process only when that pod is the one the handle's boot id came
	 * from.
	 *
	 * The two halves have to come from the same pod or the answer is a
	 * fabrication: the boot id of the pod this handle is bound to, printed
	 * beside the uid of a replacement nobody has heard a word from, names a
	 * process that pod never ran. `undefined` is what "nothing has answered
	 * from there yet" looks like, and it is the only honest thing to say.
	 */
	const guestSeen = (uid: string | undefined): KubernetesWorkspaceIdentity => {
		const live = identityNow()
		return {
			...live,
			podUid: uid,
			guestBootId: uid !== undefined && uid === live.podUid ? live.guestBootId : undefined,
		}
	}

	/**
	 * This handle's identity as one COMMAND saw it: the pod its reservation
	 * was accepted by and the process inside it, where the transport kept
	 * them ({@link guestWhenReserved}), and the handle's own where it did not.
	 *
	 * What a diagnosis compares against has to be the command's guest and not
	 * the handle's. The handle moves — it follows a replaced pod, and the
	 * failing call's own `cancel-execution` refusal already advanced its boot
	 * id on the way in — so reading it here would report the guest that is
	 * running NOW as the guest that died.
	 */
	const identityWhenReserved = (
		reserved: KubernetesReservedGuest | undefined,
	): KubernetesWorkspaceIdentity => {
		const live = identityNow()
		if (reserved === undefined) return live
		const pod = reserved.podUid ?? live.podUid
		return {
			...live,
			podUid: pod,
			// Never the handle's boot id for a DIFFERENT pod than the one
			// being named — see {@link guestSeen}.
			guestBootId: reserved.guestBootId ?? (pod === live.podUid ? live.guestBootId : undefined),
		}
	}

	/**
	 * Tell every subscriber, and let none of them fail the call that noticed.
	 *
	 * Synchronous and in subscription order, so a host can keep its own book
	 * up to date before the call that discovered the restart returns. A
	 * listener that throws is swallowed for the reason every notification
	 * callback in this file is: the caller's result is already decided, and a
	 * host's bookkeeping bug must not become the workspace's error.
	 */
	const announceGuestRestart = (event: KubernetesGuestRestart): void => {
		for (const listener of [...restartListeners]) {
			try {
				listener(event)
			} catch {
				// See above.
			}
		}
	}

	/**
	 * Follow the agent PROCESS behind every authenticated reply.
	 *
	 * Installed on the transport for both address modes, because this is the
	 * one thing no address and no token can reveal: the kubelet restarts a
	 * crashed container INSIDE the same pod, so the uid — and therefore the
	 * bind token — is unchanged and every call keeps working, while every
	 * process the caller started is gone. Only the guest's own boot id says
	 * so, and only on replies it was already sending.
	 *
	 * It never fires for the FIRST reply after the pod changed: `guestBootId`
	 * is undefined then, and the first value is the baseline rather than a
	 * change. That is what makes the caller's own suspend/resume silent.
	 *
	 * `generation` guards it exactly as {@link refreshBoundPod}'s does, and
	 * for the same reason: a reply from a session this handle has already let
	 * go says nothing about the guest it is bound to now. A late frame from a
	 * retired transport would otherwise set the boot id back to the dead
	 * pod's, announce a restart nobody had, and make the live pod's next
	 * reply announce a second one.
	 *
	 * `from` — the bind token of the wire the reply arrived on — is the same
	 * guard one level down, and a REBIND needs it because it does not retire
	 * the session: it swaps the pod under a session that goes on. The
	 * transport keeps no lock on the wire it leaves, so the outgoing pod can
	 * still answer a call dispatched to it (a `write-file` mid-flight, a pod
	 * inside its termination grace period) after this handle has followed the
	 * replacement. Taken as this session's, that reply would seed the
	 * replacement's baseline with the DEPARTED pod's process — so
	 * `workspace.identity`, and the `container-restarted` event the next real
	 * reply then fires, would name a process that never ran in the pod beside
	 * it. A pod the handle has left says nothing at all, which is exactly
	 * what a retired session's reply says.
	 */
	const observeGuestReply = (
		generation: number,
		from: string | undefined,
		reply: { readonly guestBootId?: string },
	): void => {
		if (generation !== sessionSeq) return
		if (from !== podUid) return
		const seen = reply.guestBootId
		if (typeof seen !== 'string' || seen === '') return
		if (guestBootId === undefined) {
			guestBootId = seen
			return
		}
		if (seen === guestBootId) return
		// Both halves name the pod this reply came from, taken from the
		// variable rather than from {@link identityNow}: the two guards above
		// have already established that `podUid` IS the pod that answered,
		// and an announcement about a guest must not be able to come out
		// naming no guest at all.
		const previous = identityOn(podUid, guestBootId)
		guestBootId = seen
		announceGuestRestart({
			reason: 'container-restarted',
			previous,
			current: identityOn(podUid, seen),
		})
	}

	/**
	 * Let go of one terminal this handle handed out, on the way to giving the
	 * pod back.
	 *
	 * A connection-bound terminal is KILLED, exactly as it always was: its
	 * program lives on this connection and the pod is going away. A session
	 * ATTACHMENT is only detached — the program is the registry's, not this
	 * connection's, and this path exists to stop a caller waiting on an
	 * `exited` that would otherwise resolve only when TCP notices, not to
	 * decide the program's fate. Either way the session dies with the pod;
	 * what differs is whether this handle claims to have ended it.
	 */
	const releaseTerminal = (terminal: KubernetesWorkspaceTerminal): void => {
		if (typeof terminal.detach === 'function') terminal.detach()
		else terminal.kill('SIGKILL')
	}
	/**
	 * The transport behind each session's inner handle.
	 *
	 * The detach/attach ops are the workspace's own surface, not the SDK
	 * `Sandbox`'s, so they are reached on the transport rather than through
	 * the inner handle — which also keeps them off the inner handle's
	 * automatic-retirement path, where an unconfirmed cancel takes the pod
	 * away. A detached command losing its connection must cost the
	 * workspace nothing, so it must not travel that road at all.
	 *
	 * Keyed by handle rather than kept in a `let`, so there is no window in
	 * which `session` and the transport disagree: `admitted()` hands out the
	 * live handle, and the transport looked up from it is that handle's own
	 * or nothing.
	 */
	const sessionTransports = new WeakMap<KubernetesSandboxHandle, KubernetesAgentTransport>()

	/** The live session's transport, refused by name if there is none. */
	const admittedTransport = (
		operation: string,
		handle: KubernetesSandboxHandle,
	): KubernetesAgentTransport => {
		const transport = sessionTransports.get(handle)
		if (transport === undefined) {
			throw new KubernetesWorkspaceSuspendedError(operation, workspaceId, name)
		}
		return transport
	}

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
	/**
	 * Whether the suspend in flight is quiescing the guest first.
	 *
	 * Kept beside the promise because it is the ONE part of a caller's
	 * request that a joining caller cannot inherit. `signal` and `epoch` are
	 * authority and lifetime — the first caller's to give, and a second
	 * caller joining a transition under them is what sharing means. A
	 * `quiesce` is a promise about the guest, and a suspend already patching
	 * over processes nobody stopped cannot keep it retroactively.
	 */
	let pendingSuspendQuiesces = false
	let pendingDelete: Promise<void> | undefined

	const deleteSandbox = async (
		signal?: AbortSignal,
		epoch?: number,
		gate?: HolderEpochReading,
	): Promise<void> =>
		// Already gone is the state DELETE was asking for, fenced or not.
		await deleteSandboxObject(target, 'destroy', epoch, signal, gate)

	/**
	 * The last Sandbox object a readiness poll read, kept for the two facts
	 * {@link bindingFromSandbox} does not carry: `metadata.uid` and the
	 * `volumeClaimTemplates` entry names.
	 *
	 * Kept rather than re-read. Every bind already GETs this object, both
	 * fields were in the reply and were being discarded, and asking for them
	 * again would be a second GET of a thing already in hand — and a second
	 * answer that could disagree with the one the bind acted on.
	 */
	let lastSandbox: SandboxResource | undefined

	const readBinding = async (
		pollSignal: AbortSignal,
	): Promise<KubernetesSandboxBinding | undefined> => {
		const sandbox = await client.request<SandboxResource>(
			'GET',
			sandboxPath(namespace, name),
			undefined,
			pollSignal,
		)
		lastSandbox = sandbox
		return bindingFromSandbox(sandbox)
	}

	/**
	 * Read the uid of each `volumeClaimTemplates` entry's PVC, once per
	 * handle, and never fail the workspace over it.
	 *
	 * The disk is the thing a workspace IS, and a host whose records say "id
	 * X holds a month of work" needs to be able to tell that disk from a
	 * different disk behind the same name. `sandboxUid` already catches the
	 * ordinary case (delete and recreate takes the PVCs with it, because the
	 * Sandbox owns them); this is what makes the claim checkable
	 * independently, and what a host compares across processes.
	 *
	 * Best-effort ON PURPOSE. It needs `get` on `persistentvolumeclaims`,
	 * which this release adds to the shipped Role and which no Role from an
	 * earlier release has. A 403 here must cost a deployment nothing but this
	 * one report — refusing to open a workspace because an OPTIONAL identity
	 * field could not be read would turn a documentation change into an
	 * outage.
	 */
	const readVolumeClaimUids = async (signal?: AbortSignal): Promise<void> => {
		if (volumeClaimsRead) return
		const entries = lastSandbox?.spec?.volumeClaimTemplates ?? []
		const uids: Record<string, string> = {}
		for (const entry of entries) {
			const claimName = entry?.metadata?.name
			if (typeof claimName !== 'string' || claimName === '') continue
			try {
				const claim = await client.request<{ metadata?: { uid?: string } }>(
					'GET',
					persistentVolumeClaimPath(namespace, name, claimName),
					undefined,
					signal,
				)
				const uid = claim?.metadata?.uid
				if (typeof uid === 'string' && uid !== '') uids[claimName] = uid
			} catch {
				// See above: an unreadable PVC leaves the entry out and
				// nothing else. `volumeClaimUids` says what could be read,
				// never what was guessed.
			}
		}
		// Both written only once the loop has finished, and in this order. The
		// per-PVC `catch` above covers the request and nothing else, so an
		// abort — or a claim name the path builder refuses — leaves through
		// here; latching the flag on the way IN would have left the uids
		// empty for the handle's life with no read left that could fill them.
		volumeClaimUids = uids
		volumeClaimsRead = true
	}

	/**
	 * The budget ran out with no pod this handle was allowed to bind, worded
	 * for the transition that ran out.
	 *
	 * Three different operator problems arrive here and one sentence cannot
	 * serve them: a resume whose controller never replaced the pod, an adopt
	 * that walked in on a pod still riding out its termination grace period,
	 * and a create whose pod never came up at all. The pod the wait was
	 * excluding is named whenever there is one, because "which pod is still
	 * there" is the first thing anyone looks up next.
	 *
	 * A fourth arrives only under `agentAddress: 'pod-ip'`, and it takes
	 * precedence over all of them: the bind DID find its pod, and what never
	 * turned up was that pod's address. Reporting "no pod this handle could
	 * bind to had appeared" about a pod the wait had already bound would send
	 * an operator after the controller for something the CNI never finished.
	 */
	const bindTimedOut = (
		policy: PodBindPolicy,
		lastError: unknown,
		addresslessPodUid?: string,
	): Error => {
		const cause = lastError !== undefined ? { cause: lastError } : undefined
		const subject = `kubernetes: workspace ${workspaceId} (Sandbox ${name})`
		const budget = `${readiness.timeoutMs}ms`
		if (addresslessPodUid !== undefined) {
			return new Error(
				`${subject} is configured with agentAddress: 'pod-ip', and ${budget} after it bound pod ${addresslessPodUid} that pod still reported no status.podIP, so there is no address to dial it at. A pod is given its IP when the CNI has finished attaching it, so a pod that never gets one has not been given a network at all. Raise readyTimeoutMs, look at the pod's events — or run with the default agentAddress: 'service' if this host is inside the cluster.`,
				cause,
			)
		}
		if (policy.transition === 'resume' && policy.retiring !== undefined) {
			return new Error(
				`${subject} was patched back to operatingMode: Running, but ${budget} later the only pod behind it was still the one it was suspended from (uid ${policy.retiring}). A resumed pod keeps the sandbox's name and gets a new uid, and that uid is the agent's bind token, so binding to the old pod would present a token the new agent refuses. The Ready condition cannot be waited on instead — the controller leaves it standing across the transition. Raise readyTimeoutMs, or look at why the controller has not replaced the pod.`,
				cause,
			)
		}
		if (policy.transition === 'adopt' && policy.retiring !== undefined) {
			return new Error(
				`${subject} was adopted while the previous pod (uid ${policy.retiring}) was still TERMINATING, and ${budget} later the controller had still not replaced it. A guest whose PID 1 ignores SIGTERM rides out its terminationGracePeriodSeconds before the replacement is created, so the adopt waits for the new pod under the same readiness budget as everything else on this path. ${NO_BINDABLE_POD_ADVICE}`,
				cause,
			)
		}
		if (policy.transition === 'adopt' && policy.awaitReplacement) {
			return new Error(
				`${subject} was adopted from operatingMode: Suspended and patched back to Running, but ${budget} later no pod this handle could bind to had appeared — the pod it was suspended from is most likely still terminating. ${NO_BINDABLE_POD_ADVICE}`,
				cause,
			)
		}
		const opened =
			policy.transition === 'create'
				? 'was created'
				: policy.transition === 'adopt'
					? 'was adopted while it was Running'
					: 'was patched back to operatingMode: Running'
		return new Error(
			`${subject} ${opened}, but ${budget} later no pod this handle could bind to had appeared. ${NO_BINDABLE_POD_ADVICE}`,
			cause,
		)
	}

	/**
	 * Wait until the Sandbox is Ready AND the pod behind it is a pod this
	 * handle is allowed to bind to — and, under `agentAddress: 'pod-ip'`, one
	 * that has an address — then read both facts off it.
	 *
	 * On create there is nothing to exclude and nothing to wait for, and this
	 * is one poll plus one read, exactly as it was. Everywhere else the pod
	 * behind the name is MOVING, and `policy` says how: `retiring` is the pod
	 * this bind must see replaced, and `awaitReplacement` says whether a read
	 * that finds no live pod at all is "not yet" — see {@link PodBindPolicy}.
	 *
	 * Excluding a pod is the whole point wherever one is named, because
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
	 * An ADDRESS-less pod is a third kind of "not yet", and only under
	 * `'pod-ip'`. The replacement pod is picked up while it is still
	 * `Pending` — that is the point of excluding by uid rather than waiting
	 * for Ready — and a `Pending` pod has no `status.podIP` until the CNI has
	 * attached it. Every real pod passes through that window, so refusing
	 * there would fail the ordinary resume in milliseconds with the whole
	 * budget unspent. It is waited out here, on the same deadline, and the
	 * timeout below names the pod that never got an address.
	 *
	 * The last failed read is carried onto the timeout as `cause`, so a wait
	 * that never found a pod still says what it kept seeing.
	 */
	const acquireBoundPod = async (
		deadline: OperationDeadline,
		policy: PodBindPolicy,
	): Promise<{ binding: KubernetesSandboxBinding; pod: KubernetesBoundPod }> => {
		const label = `workspace ${workspaceId} (Sandbox ${name})`
		const needsPodIP = options.agentAddress === 'pod-ip'
		let lastError: unknown
		/** The last live-but-address-less pod seen, for the timeout's words. */
		let addresslessPodUid: string | undefined
		/**
		 * Whether the Sandbox has been seen Ready at least once.
		 *
		 * It decides who gets to report a budget that ran out inside the
		 * readiness poll. Before the first Ready, "never became Ready" is the
		 * true sentence and `pollForBinding`'s own error is the right one. After
		 * it, the clock was being spent waiting for a POD, and blaming a
		 * condition that has been True the whole time points the operator at
		 * the one thing that is not the problem — see {@link bindTimedOut}.
		 *
		 * It rewrites nothing else: a readiness read that failed while the
		 * budget still had time left failed on its own account.
		 */
		let seenReady = false
		while (deadline.remainingMs() > 0) {
			let binding: KubernetesSandboxBinding
			try {
				binding = await pollForBinding(readBinding, deadline, readiness, label)
			} catch (err) {
				// Only a clock that has actually run out is rewritten. A
				// readiness read that fails for any other reason — the API
				// server refused it, the caller aborted — is that call's own
				// failure and travels out unchanged. That matters most while a
				// `'pod-ip'` bind is waiting for an address: replacing a 5xx
				// with "the CNI never gave the pod an address" sends an operator
				// to the pod's events for a fault that was never the pod's, and
				// claims an elapsed time that never elapsed.
				//
				// The error is what says which happened, and only the error
				// can: an expiry does not arrive here as an
				// `OperationDeadlineExpired` — {@link pollForBinding} catches
				// that itself and reports it in its own words, as
				// {@link ReadinessPollTimeout} — and asking the clock instead
				// is wrong by a fraction of a millisecond, because the expiry
				// timer and `performance.now()` are different clocks and the
				// timer can fire first.
				if (!seenReady || !(err instanceof ReadinessPollTimeout)) throw err
				// Kept only if no pod read has failed yet: what the wait kept
				// seeing is more useful as the cause than the clock running out.
				lastError ??= err
				break
			}
			seenReady = true
			let pod: KubernetesBoundPod | undefined
			try {
				pod = await deadline.run(
					async (tokenSignal) => await readBoundPod(client, namespace, binding, tokenSignal),
				)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				if (!policy.awaitReplacement) throw err
				lastError = err
				pod = undefined
			}
			// The IP travels WITH the uid, from this same read: a resumed pod
			// is a new pod at a new address, so a `'pod-ip'` session that
			// carried yesterday's IP would dial a pod that no longer exists.
			if (pod !== undefined && pod.uid !== policy.retiring) {
				if (!needsPodIP || pod.podIP !== undefined) return { binding, pod }
				addresslessPodUid = pod.uid
			}
			try {
				await deadline.delay(readiness.pollIntervalMs)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				throw err
			}
		}
		throw bindTimedOut(policy, lastError, addresslessPodUid)
	}

	/**
	 * The ONE re-read behind every rebind: the routine the transport runs
	 * when a call failed in a way that proves it ran nothing in the guest.
	 *
	 * It serves both triggers and both address modes, and generalising it is
	 * the whole of this workstream's transport change. `'pod-ip'` needed it
	 * first, for a dial that could not connect because the address died with
	 * its pod. The DEFAULT `'service'` mode needs it for the opposite
	 * symptom: the Service FQDN outlives the pod and resolves to the
	 * replacement, so the dial succeeds and the new agent refuses the old
	 * pod's uid — a flat `unauthorized` that used to be the end of the
	 * handle.
	 *
	 * What it decides, in order, and why each answer is the only safe one:
	 *
	 *  - **A different Sandbox uid, or no Sandbox at all** ⇒
	 *    {@link KubernetesWorkspaceReplacedError}, and never a rebind. The
	 *    name is deterministic, so this is a workspace somebody deleted and
	 *    created again: an EMPTY disk behind a name whose records say
	 *    otherwise. The transport rethrows this one rather than swallowing
	 *    it, because it is a verdict about the object and not a failed
	 *    diagnosis.
	 *  - **Suspended** ⇒ the current handle, unchanged. There is no pod to
	 *    bind and nothing here to say about it; the failing call's own
	 *    {@link admitted} re-read is what turns this into a
	 *    `KubernetesWorkspaceSuspendedError` naming the foreign suspend.
	 *  - **Running, same uid, a live pod** ⇒ that pod's address and token.
	 *    The transport installs it only if the token actually moved, so an
	 *    unchanged pod leaves the caller's original error standing — a pod
	 *    that is still there and still refusing is a guest problem, and
	 *    replacing that error with a later one would hide it.
	 *
	 * `generation` is what serialises this with the transitions WITHOUT
	 * taking their queue — which it must not, because the privilege probe
	 * runs inside a transition and a rebind that waited on the queue would
	 * deadlock the resume holding it. Every transition bumps `sessionSeq`
	 * before it changes the pod ({@link dropSession}, and `startSession`
	 * itself), so a re-read that lands after a suspend or a resume no longer
	 * matches and writes nothing: the transport may still swap the handle of
	 * a session nothing is using, which costs nobody anything, and the
	 * handle's own `podUid` — which `retiredPodUid` is stamped from — is
	 * never written by a session that has been retired.
	 */
	const refreshBoundPod = (
		binding: KubernetesSandboxBinding,
		generation: number,
		opened: KubernetesAgentAddress,
	): ((signal?: AbortSignal) => Promise<KubernetesAgentAddress>) => {
		/**
		 * What the transport is dialing right now, so "nothing changed" can
		 * be said by handing back exactly that.
		 *
		 * It must be the CURRENT one and not the one this session opened
		 * with: the transport rebinds whenever the token it is given differs
		 * from the token it holds, so answering a later re-read with the
		 * original address would drag a handle that has already followed a
		 * replacement back onto the pod it left.
		 */
		let dialing = opened
		return async (signal) => {
			let sandbox: SandboxResource | undefined
			try {
				sandbox = await readSandboxObject(target, signal)
			} catch (err) {
				// A DELETE cascades to the disk, so a name with no object
				// behind it is not "not yet" — it is the end of this
				// workspace, and the one answer that must never be followed.
				if (err instanceof KubernetesAlreadyGoneError) {
					throw new KubernetesWorkspaceReplacedError(workspaceId, name, sandboxUid, undefined, {
						cause: err,
					})
				}
				throw err
			}
			const standing = sandbox?.metadata?.uid
			// Read before anything else, and refused before anything else: a
			// disk that is not this handle's disk is the one answer no retry
			// and no rebind may follow.
			if (sandbox === undefined || (sandboxUid !== undefined && standing !== sandboxUid)) {
				throw new KubernetesWorkspaceReplacedError(workspaceId, name, sandboxUid, standing)
			}
			// Somebody else suspended it. There is no pod, and saying so here
			// would be a worse error than the one `admitted` is about to
			// produce, which names the suspension and what to do about it.
			if (operatingModeOf(sandbox) === 'Suspended') return dialing
			const refreshed = bindingFromSandbox(sandbox) ?? binding
			const pod = await readBoundPod(client, namespace, refreshed, signal)
			const next = resolveAgentAddress(refreshed, options.agentPort, pod.uid, {
				mode: options.agentAddress,
				...(pod.podIP !== undefined ? { podIP: pod.podIP } : {}),
			})
			dialing = next
			if (generation === sessionSeq && pod.uid !== podUid) {
				// The pod this handle was bound to a moment ago, and the last
				// process heard from INSIDE it — read out of the variables
				// this routine is holding rather than assembled from the
				// handle's state. That is the whole difference on the one
				// path this announcement matters most: a pod replaced during
				// a RESUME is discovered by the privilege probe, which runs
				// while `state` is still `'suspended'`, and an identity built
				// from a state gate would announce a pod replacement while
				// naming neither pod.
				const previous = identityOn(podUid, guestBootId)
				podUid = next.token
				podSession = sessionSeq
				// A new pod is a new agent process, and the boot id it will
				// report is not the one the handle has been comparing
				// against. Clearing it is what stops the first reply from the
				// replacement being announced a second time as a container
				// restart — and it is why `current.guestBootId` on the event
				// below is `undefined`: the replacement has not answered yet,
				// and naming a process nobody has heard from would be a
				// guess. A listener reads `current.podUid` for what moved,
				// and `workspace.identity` once its own call has returned for
				// the process that answered from there.
				guestBootId = undefined
				announceGuestRestart({
					reason: 'pod-replaced',
					previous,
					current: identityOn(next.token, undefined),
				})
			}
			return next
		}
	}

	/**
	 * Bring up one pod's worth of state: wait for a pod that is not the one
	 * being replaced, read its bind token, re-resolve the address, build the
	 * transport and prove the guest is deprivileged. Called on create and on
	 * every resume, with nothing carried over between them.
	 */
	const startSession = async (
		policy: PodBindPolicy,
		signal?: AbortSignal,
	): Promise<KubernetesSandboxHandle> => {
		const deadline = new OperationDeadline(
			readiness.timeoutMs,
			`kubernetes workspace ${name} ${policy.transition}`,
			signal,
		)
		// Both of these are re-read rather than remembered: a resumed pod keeps
		// the name and changes the uid and the IP, so a handle that reused
		// either would present a token the new agent refuses, at an address
		// whose pod is being deleted.
		const { binding, pod } = await acquireBoundPod(deadline, policy)
		const token = pod.uid
		// From the readiness GET the bind just made, not from a read of its
		// own — see `lastSandbox`. Fixed for the handle's life: a later bind
		// that found a DIFFERENT object would have been refused by
		// `refreshBoundPod` long before it got here.
		sandboxUid ??= lastSandbox?.metadata?.uid
		// Recorded before the probe, not after: a probe that refuses suspends
		// this pod, and the resume that follows has to know which pod it is
		// waiting to see replaced.
		podUid = token
		// A new pod is a new agent process. Clearing it is what makes the
		// caller's own suspend/resume silent: the first reply from the new
		// guest establishes an identity rather than differing from the old
		// one's.
		guestBootId = undefined
		sessionSeq += 1
		// Written together with the counter, so that `podUid` belongs to THIS
		// session for as long as this session is the live one — which is what
		// {@link boundToPod} asks, and what makes a handle mid-resume report
		// the pod it has just bound rather than nothing at all.
		podSession = sessionSeq
		const generation = sessionSeq
		const address = resolveAgentAddress(binding, options.agentPort, token, {
			mode: options.agentAddress,
			...(pod.podIP !== undefined ? { podIP: pod.podIP } : {}),
		})
		// A box rather than a `let`, so the callback below can name the handle
		// it belongs to before that handle exists. Nothing can call it in
		// between: `release` is reachable only THROUGH the handle.
		const own: { handle?: KubernetesSandboxHandle } = {}
		const transport = new KubernetesAgentTransport(address, {
			// The backend opts in to the stream heartbeat; the transport
			// option it sets stays undefined for every other tier.
			heartbeatMs: options.streamHeartbeatMs,
			// Installed for BOTH address modes now. Under `'pod-ip'` it
			// follows an address that died with its pod; under the default
			// `'service'` mode the address is fine and the TOKEN is what
			// moved — see {@link refreshBoundPod}.
			refreshHandle: refreshBoundPod(binding, generation, address),
			// And the one fact no address and no token can carry: which
			// agent PROCESS answered. The two values beside it say whose
			// answer it is — this session's, and this session's CURRENT pod's
			// — because neither a retired session's transport nor the wire a
			// rebind left behind stops answering when it stops counting.
			onGuestReply: (reply, from) => observeGuestReply(generation, from, reply),
		})
		const inner = buildKubernetesSandbox({
			name,
			rootDir: options.rootDir,
			transport,
			// Deliberately NOT `deleteSandbox` — see {@link retireSession}. On
			// the task path `release` is a DELETE because the object is
			// disposable; here the same callback would erase the caller's disk
			// from a path nobody asked to erase anything.
			release: async (releaseSignal) => {
				await retireSession(own.handle, releaseSignal)
			},
			// And `release` is not reached from the unconfirmed-cancellation
			// path at all any more: this hook answers it instead, keeping the
			// pod — see {@link keepPodOnUnconfirmedCancellation}.
			onUnconfirmedCancellation: async (error) =>
				await keepPodOnUnconfirmedCancellation(transport, error),
			// No `renew`, and so no lease loop: a workspace carries no expiry.
		})
		own.handle = inner
		sessionTransports.set(inner, transport)
		// The same probe every task acquire runs, on every resume as well as on
		// create — a resumed pod is a new pod, from a possibly re-pulled image,
		// and "it was deprivileged last week" is not a check.
		await probeSandboxPrivileges(inner, name, resolveProbeTimeoutMs(readiness.timeoutMs), signal)
		// After the probe, so a workspace that is about to be refused never
		// spends a round trip per volume on an identity nobody will read; and
		// only once per handle, for the reason `readVolumeClaimUids` gives.
		await readVolumeClaimUids(signal)
		return inner
	}

	/**
	 * Drop the live session, and with it the right of anything still holding
	 * that session's transport to report a pod.
	 *
	 * The two happen together or the guard in {@link refreshBoundPod} is a
	 * lie: a retired session's transport can still be unwinding a call, and a
	 * re-read that lands after the drop would write `podUid` for a session
	 * nothing is using — including in the window before a suspend stamps
	 * `retiredPodUid` from it.
	 */
	const dropSession = (): void => {
		session = undefined
		sessionSeq += 1
	}

	/** Kill and await every terminal this handle returned. */
	const reapTerminals = async (): Promise<void> => {
		const open = [...terminals]
		for (const terminal of open) releaseTerminal(terminal)
		await Promise.allSettled(open.map((terminal) => terminal.exited))
		terminals.clear()
	}

	/**
	 * What an execution whose cancellation could not be CONFIRMED does to a
	 * workspace: nothing to the cluster, and one bounded question to the
	 * agent.
	 *
	 * `buildKubernetesSandbox` used to retire the sandbox here on its own
	 * initiative — the shared controller's rule is that a command of unknown
	 * state makes the pod unusable, and on a task sandbox retiring means
	 * DELETING a disposable object with a scratch disk. On a workspace the
	 * same decision reached {@link retireSession} and sent an
	 * `operatingMode: Suspended` patch, which makes the controller delete the
	 * pod. So eight seconds of network loss under one `exec()` — or a pod
	 * evicted under an in-flight command, which can never confirm anything —
	 * took every holder's terminals, dev servers and running commands away,
	 * on a decision no caller issued and no host-side lock could prevent.
	 *
	 * The pod is therefore KEPT, and what the host is told instead is the one
	 * thing the error cannot carry: whether the agent is still serving
	 * (`ok`), has fenced itself (`retiring`), or could not be reached at all.
	 * Today's `healthz()` boolean collapses the last two, which is why this
	 * asks {@link KubernetesAgentTransport.agentHealth} instead.
	 *
	 * The `exec()` still rejects with `RemoteCancellationUnknownError`, now
	 * carrying `accepted: false` with `reason: 'workspace-kept'` so a host
	 * cannot read it as a patch that was attempted and failed. A host that
	 * wants the old behaviour calls `suspend()` from the callback.
	 */
	const keepPodOnUnconfirmedCancellation = async (
		transport: KubernetesAgentTransport,
		error: Error,
	): Promise<SandboxRetirementObservation> => {
		// The guest THIS command reserved against, kept per execution by the
		// transport. Never the handle's own pod and process: a restart the
		// handle survived an hour ago is not evidence about a command started
		// after it, and a pod another call has ALREADY rebound to is not the
		// pod this command's processes died with. Reading the handle would
		// answer `container-restarted` for every later unconfirmed
		// cancellation in the session and would name the replacement as the
		// guest that died.
		const reserved = guestWhenReserved(error)
		const previous = identityWhenReserved(reserved)
		const agent = await diagnoseAgent(transport)
		const { evidence, current } = await diagnoseGuest(previous, reserved?.guestBootId)
		// Recorded against the error itself, so the call that is about to
		// receive it can name the diagnosis rather than repeat the work —
		// see {@link admitted}. A WeakMap rather than a field on the error:
		// the class belongs to the shared controller and this is one
		// backend's evidence about it.
		if (evidence !== 'same-guest' && evidence !== 'unknown') {
			guestGoneEvidence.set(error, { evidence, previous, current })
		}
		try {
			options.onCancellationUnconfirmed?.({ error, agent, guest: evidence, previous, current })
		} catch {
			// A host's callback is not allowed to change the error the caller
			// is already receiving, and a throwing one must not become an
			// unaccepted retirement carrying somebody else's failure.
		}
		return { accepted: false, reason: WORKSPACE_KEPT_REASON }
	}

	/**
	 * Was the guest the command was running in replaced while it ran?
	 *
	 * This is the DIAGNOSIS half of the unconfirmed-cancellation rule, and it
	 * is deliberately only that. Nothing here patches, deletes or suspends
	 * anything — a `Suspended` patch cannot stop a command whose pod is
	 * already gone, and sending one would take the replacement pod away from
	 * every other holder. What the host gets instead is the evidence:
	 * `healthz` (beside this, in {@link diagnoseAgent}) says whether SOME
	 * agent is serving at that address; this says whether it is the same one.
	 *
	 * The boot id is asked first because it is free — it rode in on replies
	 * the handle already received, the `cancel-execution` refusal included —
	 * and because it is the only evidence for the case no API read can see: a
	 * container restarted in place keeps the pod, the uid and the token, and
	 * changes nothing an API server would report. `reservedIn` is the guest
	 * THIS command reserved against, not the one this session opened on: the
	 * question is whether the command's own guest went away, so a restart the
	 * handle survived before the command started is not evidence about it.
	 *
	 * Bounded by its own short deadline and run WITHOUT the caller's signal,
	 * for the reason {@link diagnoseAgent} gives: the caller's signal is
	 * quite possibly what started the cancellation.
	 *
	 * Every failure answers `unknown`, never a guess. This evidence decides
	 * whether the caller is told its guest is gone, and saying so on the
	 * strength of one 500 on a pod GET would be worse than saying nothing.
	 */
	const diagnoseGuest = async (
		previous: KubernetesWorkspaceIdentity,
		reservedIn: string | undefined,
	): Promise<{ evidence: KubernetesGuestEvidence; current: KubernetesWorkspaceIdentity }> => {
		// A handle that is not RUNNING is inside a transition it asked for:
		// the pod going away IS that transition, and a caller who typed
		// `suspend()` under a command of their own is not being told their
		// guest vanished. Only a handle that still believes it is running has
		// a question here — which is the case the whole diagnosis is for.
		if (state !== 'running') return { evidence: 'unknown', current: identityNow() }
		const bound = previous.podUid
		if (bound === undefined) return { evidence: 'unknown', current: identityNow() }
		// The one piece of evidence that needs no API read: the handle has
		// heard from a DIFFERENT agent process than the one this command
		// reserved against. Computed here and CONSULTED below, after the pod
		// read, because it cannot tell a container restarted in place from a
		// pod another call rebound to — both leave the handle talking to a
		// process the command never reserved against, and only the pod read
		// says which happened. It is the answer when no read succeeds at all.
		const restartedInPlace =
			reservedIn !== undefined && guestBootId !== undefined && guestBootId !== reservedIn
		try {
			return await new OperationDeadline(
				CANCELLATION_DIAGNOSIS_TIMEOUT_MS,
				`kubernetes workspace ${name} guest diagnosis`,
			).run(async (deadlineSignal) => {
				const sandbox = await readSandboxObject(target, deadlineSignal)
				// No object, or one somebody replaced: not this workspace any
				// more, and not something to claim a verdict about here — the
				// next call's rebind refuses it by name.
				if (sandbox === undefined || sandbox.metadata?.uid !== previous.sandboxUid) {
					return { evidence: 'unknown' as const, current: identityNow() }
				}
				// Somebody suspended it, so there is genuinely no pod — but
				// naming the mode is #473's job and not this one's. The
				// evidence is reported to the host's callback; the ERROR the
				// caller receives is decided by {@link admitted}, which asks
				// about a foreign suspend BEFORE it renames anything, so this
				// answer never pre-empts `KubernetesWorkspaceSuspendedError`.
				if (operatingModeOf(sandbox) === 'Suspended') {
					return { evidence: 'pod-gone' as const, current: guestSeen(undefined) }
				}
				const binding = bindingFromSandbox(sandbox)
				if (binding === undefined) {
					return { evidence: 'pod-gone' as const, current: guestSeen(undefined) }
				}
				const pod = await readBoundPod(client, namespace, binding, deadlineSignal)
				// A DIFFERENT pod outranks the boot id. Both say the command's
				// guest is gone; only this one says where it went, and calling
				// a replacement a restarted container would tell a host the
				// address and the token still work when neither does.
				if (pod.uid !== bound) {
					return { evidence: 'pod-replaced' as const, current: guestSeen(pod.uid) }
				}
				if (restartedInPlace) {
					return { evidence: 'container-restarted' as const, current: guestSeen(pod.uid) }
				}
				return { evidence: 'same-guest' as const, current: guestSeen(pod.uid) }
			})
		} catch {
			// Including `readBoundPod`'s own refusal, which means "no live pod
			// AND no pod its selector matched" but is also what an API server
			// returning 500 produces. One error for two facts is not evidence
			// — but a boot id that already moved is evidence of its own, and
			// it was never the API server's to confirm.
			if (restartedInPlace) return { evidence: 'container-restarted', current: identityNow() }
			return { evidence: 'unknown', current: identityNow() }
		}
	}

	/**
	 * One bounded `healthz` over a fresh connection, and never anything else.
	 *
	 * Bounded by its own short deadline rather than by the caller's: the
	 * caller's signal is quite possibly what started the cancellation in the
	 * first place, and a diagnosis that inherited it would report every
	 * aborted call as an unreachable agent. Fresh, because every request on
	 * this transport dials fresh — there is no cached socket to reuse and no
	 * pooled connection whose state could answer for the pod.
	 *
	 * A failure is an ANSWER here, not an error to propagate: an agent that
	 * cannot be reached is exactly the `unreachable` case, and this whole
	 * routine exists to report rather than to decide.
	 *
	 * `unreachable` also covers a reply that is neither: the agent's
	 * connection gate refuses a `healthz` that arrived over one
	 * unauthenticated connection too many with a named `{ ok: false, error }`
	 * and no fence flag. The probe got no answer about the agent's health
	 * there, which is what `unreachable` means — reading it as `retiring`
	 * would advise a `suspend()` on a healthy pod, and as `ok` would claim a
	 * pod is serving on a reply that said the opposite.
	 */
	const diagnoseAgent = async (
		transport: KubernetesAgentTransport,
	): Promise<KubernetesWorkspaceAgentState> => {
		try {
			const health = await new OperationDeadline(
				CANCELLATION_DIAGNOSIS_TIMEOUT_MS,
				`kubernetes workspace ${name} agent diagnosis`,
			).run(async (deadlineSignal) => await transport.agentHealth(deadlineSignal))
			return health.retiring ? 'retiring' : health.ok ? 'ok' : 'unreachable'
		} catch {
			return 'unreachable'
		}
	}

	/**
	 * Retire one session's pod WITHOUT deleting anything.
	 *
	 * This is the inner handle's `release` on a workspace, and the difference
	 * from the task path is the entire reason that callback is a parameter
	 * rather than a DELETE both paths share: for a task sandbox retiring IS
	 * deleting, because the object is disposable and its disk is scratch.
	 * Here it is not — the DELETE cascades to the PVC, and nothing but a
	 * caller naming a disk (`deleteDisk: true`, or
	 * {@link deleteKubernetesWorkspace}) is allowed to remove one. That is the
	 * invariant the whole file is built around.
	 *
	 * So the pod is retired the way `suspend()` retires one, with the same
	 * `operatingMode: Suspended` patch, and the workspace is left
	 * `suspending`: nothing is admitted, the disk is untouched, and `resume()`
	 * brings up a fresh pod. A patch that FAILS is not swallowed — it travels
	 * back out through the inner handle's `destroy()` on the error the caller
	 * is already receiving.
	 *
	 * The path that used to reach this — an unconfirmed cancellation — no
	 * longer does: see {@link keepPodOnUnconfirmedCancellation}. What is left
	 * is the inner handle's own `destroy()`, and the workspace's delete drops
	 * the session before it calls that, so in practice this is a guard rather
	 * than a verb. It stays because the callback is required and because a
	 * `release` that silently did nothing would be a worse answer than one
	 * that does the safe thing if a future path ever reaches it.
	 *
	 * `retiring` is the handle the callback was built for. When it is not the
	 * current session there is nothing to retire and this is a no-op: a resume
	 * has already replaced it, or `deleteNow` dropped it on the way to a
	 * DELETE — which must not be preceded by a suspend patch, and says so by
	 * dropping it.
	 *
	 * It never touches the transition queue, and must not: it is awaited
	 * inside a failing call, and that call can be the privilege probe of the
	 * resume currently HOLDING the queue.
	 */
	const retireSession = async (
		retiring: KubernetesSandboxHandle | undefined,
		signal?: AbortSignal,
	): Promise<void> => {
		if (retiring === undefined || retiring !== session) return
		dropSession()
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
		// Fenced by whatever this handle holds, like every other write it
		// sends on its own: a superseded handle's release must not suspend the
		// pod the new holder is using. The refusal travels out on the error
		// the caller is already receiving, exactly as a refused patch does.
		await writeOperatingMode(target, 'retire', 'Suspended', heldEpoch, signal)
		// The patch landed, so the controller is taking this pod away and the
		// next resume must see it replaced rather than bind it.
		retiredPodUid = podUid
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
	const suspendNow = async (
		signal?: AbortSignal,
		epoch?: number,
		quiesceRequest?: KubernetesWorkspaceQuiesceRequest,
	): Promise<void> => {
		if (state === 'deleted') throw new KubernetesSandboxDestroyedError('suspend', name)
		// `suspending` deliberately falls through: the patch is re-sent and
		// the pod waited for again. Only a CONFIRMED suspend returns here.
		if (state === 'suspended') return
		const before = state
		// BEFORE the terminals are reaped, which is the whole point of doing
		// the read here rather than letting the patch below carry the refusal
		// on its own: `reapTerminals` SIGKILLs every session this handle
		// handed out, and a superseded holder that learned it was superseded
		// from the write would already have taken its own caller's terminals
		// away on a write that never applied. The reading is reused as the
		// patch's condition, so the gate costs no extra round trip.
		const gate = await readHolderEpochGate(target, 'suspend', epoch, signal)
		// A terminal owns an interactive process tree in a pod that is about
		// to be taken away, so it is stopped first — and stays stopped even if
		// the patch below fails. `suspend()` is a declaration that nobody is
		// using this workspace; killing the sessions that say otherwise is the
		// point of it rather than a cost of it.
		await reapTerminals()
		// And then, if the caller asked for it, everything else in the guest:
		// the terminals another handle opened, the commands already running,
		// and the programs that left every session this handle knows about.
		// HERE and nowhere later — `admit` refuses every call the moment the
		// state leaves `running` below, so a quiesce after that point could not
		// reach the pod it is quiescing. A quiesce that cannot be confirmed
		// throws from here, before `state` has moved and before any patch has
		// been sent: the pod is still running, this handle can still serve it,
		// and the caller is told which pid would not stop.
		//
		// A re-sent suspend (`state === 'suspending'`, the fall-through above)
		// does NOT re-quiesce: its patch has already landed, its session was
		// dropped with it, and there is no admitted call left to ask through.
		if (quiesceRequest !== undefined && quiesceRequest !== false && state === 'running') {
			await quiesceBeforeSuspend(quiesceRequest, signal)
		}
		// From here on nothing new is admitted: the pod is going away, and a
		// call let through would dial an address that still resolves — the
		// Service outlives the pod — and hang on a connect timeout naming
		// nothing. This is NOT the terminal state; a patch that fails puts it
		// straight back.
		state = 'suspending'
		try {
			await writeOperatingMode(target, 'suspend', 'Suspended', epoch, signal, gate)
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
		if (epoch !== undefined) heldEpoch = epoch
		dropSession()
		await awaitPodRetired(client, namespace, name, workspaceId, readiness, signal)
		state = 'suspended'
	}

	/**
	 * Wake the workspace if it is asleep, then bring a session up on it.
	 *
	 * The mode is READ before the patch rather than patched blind, for the
	 * same reason {@link adoptExistingWorkspace} reads it: a workspace this
	 * handle believes is suspended may already have been resumed by another
	 * process, whose pod is serving its terminals right now. Patching Running
	 * over Running would change nothing on the cluster but would make this
	 * call the apparent author of a mode change it did not make — and a start
	 * that then failed would suspend somebody else's live pod. It also keeps
	 * {@link OPERATING_MODE_CHANGED_AT_ANNOTATION_KEY} honest: the annotation
	 * says when the mode last CHANGED, and a no-op patch would restamp it.
	 *
	 * The extra GET is one round trip on a rare, explicit transition, which
	 * is the same trade the adopt path already makes.
	 */
	const resumeNow = async (
		signal?: AbortSignal,
		onStartFailure: KubernetesWorkspaceStartFailurePolicy = defaultStartFailure,
		epoch?: number,
		refreshPodTemplate = false,
	): Promise<void> => {
		if (state === 'deleted') throw new KubernetesSandboxDestroyedError('resume', name)
		if (state === 'running') {
			// Resuming a running workspace sends nothing — unless it carries
			// an epoch, in which case the ONE thing it is asking for is the
			// thing that still has to happen: take this workspace over. That
			// is a write, even though the mode does not move, and a `resume()`
			// that silently dropped it would leave the new holder unfenced.
			if (epoch === undefined) return
			await writeOperatingMode(target, 'resume', undefined, epoch, signal)
			heldEpoch = epoch
			return
		}
		// The pod a landed suspend patch took away is one this resume must see
		// replaced rather than bound — see `acquireBoundPod` and
		// `retiredPodUid`. Where there is none to exclude this is one poll
		// plus one read, exactly as it is on create.
		const replacing = retiredPodUid
		// One GET, read twice: the mode decides whether a patch is sent at all
		// and the epoch decides whether it may be. Reading both off the same
		// object rather than off two GETs is what keeps an unfenced resume's
		// request log identical to what it always was.
		const current = await readSandboxObject(target, signal)
		let woke = operatingModeOf(current) === 'Suspended'
		const reading = readHolderEpoch(current?.metadata)
		if (epoch !== undefined) assertHolderEpochAllows(target, 'resume', epoch, reading)
		// Off the GET this path already makes, so an unfenced resume that asks
		// for no refresh sends and reads exactly what it always did: whatever
		// the object says it was built from, including a refresh another
		// process applied while this handle slept.
		templateRevision = readPodTemplateHash(current?.metadata)
		if (woke && refreshPodTemplate) {
			// The template is re-read HERE rather than remembered from the
			// open: the whole point of the option is to pick up an edit made
			// since, and a cached copy would refresh a workspace onto the
			// template as it stood when the handle was created.
			const template = await readSandboxTemplate(
				client,
				namespace,
				options.sandboxTemplateName,
				signal,
			)
			const refresh = buildPodTemplateRefresh(
				template,
				options.sandboxTemplateName,
				options.runtimeClassName,
				options.podLabels,
			)
			currentTemplateHash = refresh.hash
			// Before any patch, and against the SANDBOX's own disk — both of
			// them, in the same order as the adopt path.
			const source = `SandboxTemplate ${options.sandboxTemplateName} in namespace ${namespace}, refreshing Sandbox ${name}`
			assertRefreshedTemplateClaimsTheSameDisks(
				source,
				refresh.volumeClaimTemplates,
				current?.spec?.volumeClaimTemplates,
			)
			assertBlockModeWorkspaceDisk(source, refresh.podTemplate, current?.spec?.volumeClaimTemplates)
			const result = await writeRefreshedPodTemplate(
				target,
				'resume',
				refresh,
				epoch,
				reading,
				signal,
			)
			if (result.applied) {
				templateRevision = refresh.hash
			} else {
				// Another process resumed it first. Nothing was written, so
				// this call did not wake the workspace and a start that fails
				// must not put somebody else's live pod back to sleep.
				woke = false
				templateRevision = readPodTemplateHash(result.sandbox.metadata)
				if (epoch !== undefined) {
					await writeOperatingMode(
						target,
						'resume',
						undefined,
						epoch,
						signal,
						readHolderEpoch(result.sandbox.metadata),
					)
				}
			}
		} else if (woke) {
			await writeOperatingMode(target, 'resume', 'Running', epoch, signal, reading)
		} else if (epoch !== undefined) {
			// Somebody else resumed it first, so there is no mode change to
			// make — but this call is still the one taking the workspace over,
			// and the stamp is what says so.
			await writeOperatingMode(target, 'resume', undefined, epoch, signal, reading)
		}
		if (epoch !== undefined) heldEpoch = epoch
		session = await startSessionOrSuspend(
			{
				transition: 'resume',
				awaitReplacement: replacing !== undefined,
				...(replacing !== undefined ? { retiring: replacing } : {}),
			},
			{ woke, policy: onStartFailure, ...(heldEpoch !== undefined ? { epoch: heldEpoch } : {}) },
			signal,
		)
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
	 *
	 * Joining is only honest while the transition in flight does everything
	 * the joining caller asked for. It carries the first caller's signal and
	 * epoch, and that is what sharing means — but a caller that asked for a
	 * `quiesce` is about to trust a capture, and a suspend already in flight
	 * WITHOUT one is on its way to patching over a guest nothing stopped. A
	 * quiesce cannot be added to it afterwards either: `admit` refuses every
	 * call the moment that transition's state leaves `running`. So such a
	 * caller is refused, by the same class an unconfirmable quiesce rejects
	 * with and for the same reason — everything this feature cannot deliver,
	 * it says out loud.
	 */
	const suspendShared = (
		signal?: AbortSignal,
		epoch?: number,
		quiesceRequest?: KubernetesWorkspaceQuiesceRequest,
	): Promise<void> => {
		const wantsQuiesce = quiesceRequest !== undefined && quiesceRequest !== false
		if (pendingSuspend !== undefined) {
			if (wantsQuiesce && !pendingSuspendQuiesces) {
				return Promise.reject(
					new KubernetesQuiesceUnconfirmedError(
						'suspend_already_in_flight',
						`kubernetes: workspace '${workspaceId}' is already suspending under a call that did not ask for a quiesce, and a quiesce cannot be added to a transition in flight — once that transition's state leaves 'running', no call is admitted to stop anything in the guest. Nothing was sent and nothing was stopped on this call's behalf: await the suspend in flight and treat the disk as one that was written to, or call quiesce() before the suspend next time. Refused rather than joined, because a caller that passed 'quiesce' is about to trust a capture.`,
					),
				)
			}
			return pendingSuspend
		}
		pendingSuspendQuiesces = wantsQuiesce
		pendingSuspend = serialise(async () => {
			try {
				await suspendNow(signal, epoch, quiesceRequest)
			} finally {
				pendingSuspend = undefined
				pendingSuspendQuiesces = false
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
	const destroyBySuspending = async (
		signal?: AbortSignal,
		epoch?: number,
		quiesceRequest?: KubernetesWorkspaceQuiesceRequest,
	): Promise<void> => {
		// Read through a call on both sides. `state` is assigned from other
		// closures, which the checker cannot see, so it takes the first
		// comparison as narrowing the second out of existence — and the second
		// is the one that matters, because it is the one reading a delete that
		// landed while this call was queued.
		const gone = (): boolean => state === 'deleted'
		if (gone()) return
		try {
			await suspendShared(signal, epoch, quiesceRequest)
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
		const epoch = destroyOptions?.epoch ?? heldEpoch
		// Before the terminals are reaped and before the session is torn
		// down, for the same reason `suspendNow` gates there: a refused
		// destroy must leave this handle exactly as it found it. The reading
		// is carried into the DELETE as its `preconditions.resourceVersion`,
		// so the gate costs no extra round trip.
		//
		// An object that is already gone is not a refusal: already gone is the
		// state DELETE was asking for, and an unfenced destroy has always
		// resolved on it. Reading the epoch must not turn that into a
		// rejection — the fence exists to stop a write, and there is no write
		// left to stop.
		let gate: HolderEpochReading | undefined
		try {
			gate = await readHolderEpochGate(target, 'destroy', epoch, destroyOptions?.signal)
		} catch (err) {
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
			state = 'deleted'
			dropSession()
			// Killed but not awaited, as every other path that learns the pod
			// is gone does it: `exited` on a session whose pod no longer
			// exists resolves only when TCP notices. The `catch` is not
			// decoration — a detached chain that rejects with no handler takes
			// the host process down.
			void reapTerminals().catch(() => undefined)
			return
		}
		await reapTerminals()
		const current = session
		// Dropped BEFORE the handle is torn down, because tearing it down runs
		// its `release` — which on a workspace is {@link retireSession}, a
		// SUSPEND patch. A delete does not want one on the way: the object is
		// going away whole. `retireSession` reads exactly this to know it.
		dropSession()
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
		await deleteSandbox(destroyOptions?.signal, epoch, gate)
		if (epoch !== undefined) heldEpoch = epoch
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
	 * Bring a session up, and put the workspace back to sleep ONLY if this
	 * call is the one that woke it.
	 *
	 * The failures that reach here are not failures OF the workspace. A
	 * caller's signal aborting during readiness, one 5xx or 429 on a Sandbox
	 * or pod GET (the client does not retry), a privilege probe that overran
	 * its own deadline — every one of them can happen to a second process
	 * adopting a workspace the first process is happily using, and the patch
	 * that used to go out on all of them makes the controller delete that
	 * pod. So the question asked here is not "did the start fail" but "did
	 * THIS call move `operatingMode`", which is what `woke` carries:
	 *
	 *  - a create POSTed the object, so the pod exists because of this call;
	 *  - an adopt or a `resume()` that found the object `Suspended` sent the
	 *    Running patch that asked for the pod;
	 *  - an adopt of an object that was already Running, or a `resume()` that
	 *    found somebody had already resumed it, moved nothing and so has
	 *    nothing to put back.
	 *
	 * The first two keep suspending, and must: a workspace this call woke and
	 * then failed to start is left Running with a pod nobody is using,
	 * burning a node until somebody notices. The third sends nothing and
	 * rethrows, which is the whole point of the rule.
	 *
	 * Suspend rather than delete, always, wherever it does patch: the failure
	 * might be a probe refusal on a workspace whose disk holds a month of a
	 * caller's work, and no failure path in this module is allowed to make
	 * that decision. The cost of being wrong the other way is one suspended
	 * Sandbox left standing, which the caller finds again under the same
	 * deterministic name.
	 *
	 * The read that decided `woke` and the patch below are deliberately NOT
	 * one conditional write. Between them another process can change the
	 * object, and this call would then suspend a mode change it did not make
	 * after all — a narrow window, and the honest way to close it is a
	 * condition ON the write rather than a second read here. Until there is
	 * one, a patch that was not refused is treated as this call's own. This
	 * comment is the single place a conditional write has to tighten.
	 */
	const startSessionOrSuspend = async (
		policy: PodBindPolicy,
		wake: WakeRecord,
		signal?: AbortSignal,
	): Promise<KubernetesSandboxHandle> => {
		try {
			return await startSession(policy, signal)
		} catch (err) {
			// `suspending`, not `suspended`, and set whether or not a patch
			// goes out below. This handle has no session either way, so it can
			// serve nothing and `resume()` is the way back — and where a patch
			// IS sent, `runFailureCleanup` swallows its own failures so that
			// the primary error stays primary, which means the patch may not
			// have landed and the pod may still be running. Only a CONFIRMED
			// suspend is ever recorded as `suspended`.
			state = 'suspending'
			dropSession()
			if (!wake.woke || wake.policy === 'leave') throw err
			let retired = false
			await runFailureCleanup(async (cleanupSignal) => {
				// Fenced by the epoch this transition carried, which closes
				// the window the comment above names: between the read that
				// decided `woke` and this patch, another holder can take the
				// workspace, and an unconditional suspend here would stop the
				// pod that holder is now using. A refusal is swallowed by
				// `runFailureCleanup` like every other cleanup failure, and
				// the primary error is still what the caller receives.
				await writeOperatingMode(target, 'start-cleanup', 'Suspended', wake.epoch, cleanupSignal)
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

	/**
	 * Adopt a suspension this handle did not perform, if the object really is
	 * suspended. Answers whether it was.
	 *
	 * Recorded as `suspending` rather than `suspended`, and the distinction is
	 * the same one the whole module turns on: what was observed is the
	 * object's MODE, not the pod stopping. The other process's wait may still
	 * be running, or may have run out. A `suspended` mark here would let this
	 * handle's next `suspend()` return on it and promise a quiesced disk
	 * nobody in this process ever waited for.
	 *
	 * `retiredPodUid` is set for the same reason `suspendNow` sets it: a
	 * suspend patch has landed — somebody else's — so the controller is taking
	 * this pod away, and the resume that follows must see it REPLACED rather
	 * than bind the uid the new agent will refuse.
	 *
	 * It never touches the transition queue, and must not: the call-failure
	 * path below runs inside a rejecting `exec()`, and that exec can be the
	 * privilege probe of a resume that is currently HOLDING the queue. The
	 * `state !== 'running'` guard is what keeps it out of a transition's way —
	 * every transition leaves `running` before it does anything.
	 */
	const noticeSuspendedElsewhere = async (signal?: AbortSignal): Promise<boolean> => {
		if (state !== 'running') return false
		if ((await readOperatingMode(client, namespace, name, signal)) !== 'Suspended') return false
		if (state !== 'running') return false
		state = 'suspending'
		dropSession()
		retiredPodUid = podUid
		// Killed but not awaited, exactly as `retireSession` does it and for
		// the same reason: the frames go to a pod that is being deleted, and
		// `exited` would otherwise resolve only when TCP notices. The `catch`
		// is not decoration — a detached chain that rejects with no handler
		// takes the host process down.
		void reapTerminals().catch(() => undefined)
		return true
	}

	/**
	 * Run one admitted call and, if it fails, ask ONCE whether the workspace
	 * has been suspended out from under this handle.
	 *
	 * The failure a foreign suspend produces is not recognisable on its own.
	 * The pod is gone, so the dial is refused — against an address that still
	 * resolves, because the Service outlives the pod — or, if a replacement
	 * pod is already up, the guest answers a flat `unauthorized` because this
	 * handle is presenting the retired pod's uid. Neither says "suspended",
	 * and a caller looking at either has no reason to try `resume()`.
	 *
	 * So the object is re-read, and only then: once per failed call, never
	 * speculatively, and never on a call that succeeded. The re-read is a
	 * diagnostic and behaves like one — it runs without the caller's signal
	 * (which is quite possibly what aborted the call in the first place), and
	 * a re-read that itself fails hands back the caller's own error rather
	 * than replacing it with a second one about the API server.
	 *
	 * That question is asked BEFORE the unconfirmed-cancellation diagnosis is
	 * turned into an error, and the order is load-bearing. A foreign suspend
	 * takes the pod away, so it looks exactly like a gone guest and produces
	 * that diagnosis too — but only one of the two answers lets the caller
	 * recover: `KubernetesWorkspaceSuspendedError` says what happened and
	 * leaves the handle suspended, so `resume()` brings a pod back. The
	 * diagnosis is the answer for a workspace that is still Running.
	 */
	const admitted = async <T>(
		operation: string,
		run: (handle: KubernetesSandboxHandle) => Promise<T>,
	): Promise<T> => {
		const current = admit(operation)
		try {
			return await run(current)
		} catch (err) {
			// The diagnosis, if one was taken — read here and ACTED ON last.
			// A foreign suspend is also a gone guest, and it is the answer
			// that outranks: #473 promises a caller that somebody else
			// suspended the workspace hears it by name, and that the handle
			// adopts the suspension so `resume()` works. Renaming first would
			// leave the handle marked running with no pod, `suspended` false
			// and `resume()` a silent no-op. So the suspend question is asked
			// first, and this is the answer when it comes back `false`.
			const diagnosis = err instanceof Error ? guestGoneEvidence.get(err) : undefined
			if (diagnosis !== undefined && err instanceof Error) guestGoneEvidence.delete(err)
			if (state === 'running') {
				let suspended = false
				try {
					suspended = await noticeSuspendedElsewhere()
				} catch {
					// A re-read that itself fails is not a better error than
					// the one the caller is already holding: fall through and
					// give them that, named if a diagnosis was taken.
					suspended = false
				}
				if (suspended) {
					throw new KubernetesWorkspaceSuspendedError(operation, workspaceId, name, 'transport', {
						cause: err,
					})
				}
			}
			// An unconfirmed cancellation whose guest is demonstrably gone
			// leaves as an error that SAYS so and carries both identities. It
			// is a subclass of the error it replaces, so nothing that catches
			// the base class stops catching it, and the rule is unchanged —
			// the outcome is still unknown and still must not be retried.
			// Nothing was patched to get here and nothing is patched on the
			// way out.
			if (diagnosis !== undefined) {
				const named = new KubernetesWorkspaceGuestGoneError(
					workspaceId,
					name,
					diagnosis.evidence,
					diagnosis.previous,
					diagnosis.current,
					{ cause: err },
				)
				if (err instanceof RemoteCancellationUnknownError) named.retirement = err.retirement
				throw named
			}
			throw err
		}
	}

	/**
	 * {@link admitted}, for a call that hands back an ITERABLE rather than a
	 * promise.
	 *
	 * Admission is taken HERE, synchronously, and only the iteration lives in
	 * the generator below: an async generator's body does not run until
	 * something pulls from it, and a suspended workspace has to refuse
	 * `readFileStream(...)` where the caller wrote it — the same place, and
	 * with the same error, as every other data-plane call. The task sandbox's
	 * own `readFileStream` checks admissibility at the call for the same
	 * reason.
	 *
	 * The one diagnostic re-read is otherwise identical, and it covers the
	 * whole stream rather than its first pull. A workspace suspended halfway
	 * through a long read takes its pod's connection with it, and what
	 * surfaces is a socket that closed early: as unrecognisable on its own as
	 * the failures `admitted` exists to name.
	 *
	 * `yield*` rather than a hand-rolled loop so that a consumer's `break`
	 * still reaches the transport's generator, whose `finally` is what
	 * destroys the socket and makes the guest release the file descriptor.
	 */
	const admittedStream = (
		operation: string,
		open: (handle: KubernetesSandboxHandle) => AsyncIterable<Buffer>,
	): AsyncIterable<Buffer> => {
		const source = open(admit(operation))
		return (async function* stream(): AsyncGenerator<Buffer, void, undefined> {
			try {
				yield* source
			} catch (err) {
				if (state !== 'running') throw err
				let suspended = false
				try {
					suspended = await noticeSuspendedElsewhere()
				} catch {
					throw err
				}
				if (!suspended) throw err
				throw new KubernetesWorkspaceSuspendedError(operation, workspaceId, name, 'transport', {
					cause: err,
				})
			}
		})()
	}

	/**
	 * One quiesce, through the live session's transport.
	 *
	 * It goes through {@link admitted} like every other data-plane call, so a
	 * workspace another process suspended underneath this handle is named as
	 * suspended rather than reported as a quiesce that failed at the
	 * transport. It is NOT serialised here: both callers are already holding
	 * the transition queue — the public verb takes it, and `suspendNow` runs
	 * inside it.
	 */
	const quiesceNow = async (
		quiesceOptions?: KubernetesQuiesceOptions,
	): Promise<KubernetesQuiesceReport> =>
		await admitted(
			'quiesce',
			async (handle) =>
				await admittedTransport('quiesce', handle).quiesce(
					quiesceOptions?.graceMs !== undefined ? { graceMs: quiesceOptions.graceMs } : {},
					quiesceOptions?.signal,
				),
		)

	/**
	 * The quiesce `suspend({ quiesce })` performs, and the ONE failure it
	 * does not pass on.
	 *
	 * An image whose agent predates the op cannot be asked, and refusing to
	 * suspend over that would make the option unusable against every pod
	 * built before this release — a caller could not even suspend such a
	 * workspace without changing its own code. So the suspend goes ahead, as
	 * it always did, and the host is TOLD through
	 * {@link KubernetesWorkspaceOptions.onQuiesceUnsupported}; the gap is
	 * reported rather than either hidden or turned into a refusal.
	 *
	 * Every other failure travels: a guest that answered and could not
	 * confirm has processes still writing to the disk, and a suspend that
	 * patched anyway would take the pod away while they did.
	 */
	const quiesceBeforeSuspend = async (
		request: KubernetesWorkspaceQuiesceRequest,
		signal?: AbortSignal,
	): Promise<void> => {
		const graceMs = typeof request === 'object' ? request.graceMs : undefined
		try {
			const report = await quiesceNow({
				...(graceMs !== undefined ? { graceMs } : {}),
				...(signal !== undefined ? { signal } : {}),
			})
			// This call answers `void`, so the scope in the report would go
			// nowhere — and a narrowed scan can miss exactly the process the
			// quiesce was asked for. Told, for the same reason the
			// unsupported gap is.
			if (report.scope !== 'pid-namespace') {
				try {
					options.onQuiesceNarrowed?.(report)
				} catch {
					// A host's callback is not allowed to decide whether the
					// suspend it was only being told about goes ahead.
				}
			}
		} catch (err) {
			if (!(err instanceof KubernetesQuiesceUnsupportedError)) throw err
			try {
				options.onQuiesceUnsupported?.(err)
			} catch {
				// A host's callback is not allowed to decide whether the suspend
				// it was only being told about goes ahead.
			}
		}
	}

	/**
	 * How the FIRST bind is allowed to behave, read off how this handle came
	 * by its object.
	 *
	 * A create POSTed the Sandbox itself: no pod existed a moment ago, no pod
	 * is being replaced, and a read that finds none is a failure to report
	 * rather than a state to wait out. An adopt is the opposite by default —
	 * the pod is somebody else's, possibly on its way out — and the two
	 * shapes that say so are the object standing `Suspended` (its pod has
	 * been taken away, and the resume patch this adopt just sent is what asks
	 * for the replacement) and a pod already carrying a `deletionTimestamp`
	 * (the controller is taking it away now). Both of those leave a window
	 * with no live pod under the name at all, which is exactly the window a
	 * host restarting inside a previous pod's terminationGracePeriodSeconds
	 * arrives in.
	 *
	 * An adopt of an object that was Running with a healthy pod keeps the
	 * create path's behaviour: nothing is being replaced, so nothing is
	 * waited for.
	 */
	const initialBindPolicy: PodBindPolicy =
		options.origin === 'created'
			? { transition: 'create', awaitReplacement: false }
			: {
					transition: 'adopt',
					awaitReplacement:
						options.origin === 'resumed' ||
						options.awaitReplacement === true ||
						options.drainingPodUid !== undefined,
					...(options.drainingPodUid !== undefined ? { retiring: options.drainingPodUid } : {}),
				}

	// The first session is brought up here so that `createKubernetesWorkspace`
	// resolves with a workspace that is Ready, addressed and probed — the same
	// contract `create()` gives a task sandbox.
	session = await startSessionOrSuspend(
		initialBindPolicy,
		// A create POSTed the object and an adopt that found it `Suspended`
		// patched it Running; an adopt of an object that was already Running
		// moved nothing, and a start that fails on it must leave the pod its
		// holder is using exactly where it found it.
		{
			woke: options.origin !== 'adopted-running',
			policy: defaultStartFailure,
			...(heldEpoch !== undefined ? { epoch: heldEpoch } : {}),
		},
		options.signal,
	)
	// Whatever the backend's own Sandbox reports, rather than a second copy of
	// the same constant: it must keep answering after a suspend has taken the
	// handle it came from away.
	const environment: SandboxEnvironment = session.environment

	return {
		id,
		origin: options.origin,
		get templateRevision(): string | undefined {
			return templateRevision
		},
		get templateCurrent(): boolean {
			// An object that recorded no revision is NOT current: unknown is
			// not a match, and reporting it as one would tell a host there is
			// nothing to refresh on exactly the workspaces created before
			// anything recorded what they were built from.
			return templateRevision !== undefined && templateRevision === currentTemplateHash
		},
		get identity(): KubernetesWorkspaceIdentity {
			return identityNow()
		},
		onGuestRestart(listener: (event: KubernetesGuestRestart) => void): () => void {
			restartListeners.add(listener)
			return () => {
				restartListeners.delete(listener)
			}
		},
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
			execOptions?: KubernetesDetachedExecOptions,
		): Promise<SandboxExecResult> {
			// The default path, untouched: the SDK's exec through the inner
			// handle, the shared execution controller, and the retirement
			// behaviour that comes with it.
			if (execOptions?.detach !== true && execOptions?.executionId === undefined) {
				return await admitted(
					'exec',
					async (handle) => await handle.exec(command, argv, execOptions),
				)
			}
			return await admitted(
				'exec',
				async (handle) =>
					await admittedTransport('exec', handle).execDetached(command, argv, execOptions),
			)
		},

		async attachExecution(
			executionId: string,
			attachOptions?: KubernetesAttachExecutionOptions,
		): Promise<SandboxExecResult> {
			return await admitted(
				'attachExecution',
				async (handle) =>
					await admittedTransport('attachExecution', handle).attachExecution(
						executionId,
						attachOptions,
					),
			)
		},

		async cancelExecution(
			executionId: string,
			transitionOptions?: KubernetesWorkspaceTransitionOptions,
		): Promise<void> {
			await admitted(
				'cancelExecution',
				async (handle) =>
					await admittedTransport('cancelExecution', handle).cancelExecution(
						executionId,
						transitionOptions?.signal,
					),
			)
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			await admitted('writeFile', async (handle) => await handle.writeFile(path, content))
		},

		/**
		 * `readOptions` is FORWARDED, and that is the whole of the
		 * requirement: a backend that takes `offset`/`length` and answers
		 * with the whole file has given a wrong answer, not a degraded one
		 * (`Sandbox.readFile` in `@namzu/sdk` says so, and the transport
		 * refuses rather than downgrades against a guest too old to honour
		 * them). A workspace that dropped them would do exactly that, on the
		 * surface most likely to be pointed at a file worth ranging.
		 */
		async readFile(path: string, readOptions?: SandboxReadFileOptions): Promise<Buffer> {
			return await admitted('readFile', async (handle) => await handle.readFile(path, readOptions))
		},

		/**
		 * Draining a large output file before `suspend()` or `destroy()`
		 * without holding it — the use a long-lived workspace exists for, and
		 * the reason this is narrowed to present on
		 * {@link KubernetesWorkspace} rather than left optional.
		 *
		 * Admission runs where the caller wrote the call, not at the first
		 * pull, exactly as the task sandbox does it; the suspended-elsewhere
		 * diagnostic runs on a failure at any point in the stream, because a
		 * workspace suspended halfway through takes its pod's connection with
		 * it and leaves only a socket that closed early.
		 */
		readFileStream(path: string, readOptions?: SandboxReadFileOptions): AsyncIterable<Buffer> {
			return admittedStream('readFileStream', (handle) => handle.readFileStream(path, readOptions))
		},

		async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
			return await admitted('listFiles', async (handle) => await handle.listFiles(rootPath))
		},

		/**
		 * Admitted ONCE, when the consumer asks for the first entry, and then
		 * delegated to the inner handle with `yield*`.
		 *
		 * {@link admit} is the synchronous gate every data-plane call on this
		 * handle passes, so a workspace this process knows to be suspended
		 * refuses a walk exactly as it refuses `readFile` — the same error
		 * class, the same `noticedBy: 'admission'`, this operation's own name —
		 * and nothing is dialed. What it deliberately does NOT do is re-admit
		 * per entry: a suspend that lands mid-walk surfaces as the transport
		 * failure it is, and this handle learns it was suspended elsewhere on
		 * its next data-plane call, which is where {@link admitted}'s one-shot
		 * diagnosis lives for every other operation.
		 *
		 * `yield*` is also what makes cancellation work with no code of its own
		 * here: a consumer breaking out of its `for await` runs this generator's
		 * `return()`, and the delegation forwards it to the inner walk — which
		 * is the call that terminates the guest's walk process.
		 *
		 * Busy accounting is not repeated either: the inner handle holds one
		 * execution for the whole walk, so `status` stays `busy` from the first
		 * entry to the last rather than flapping between them.
		 */
		async *walkFiles(
			rootPath: string,
			walkOptions: SandboxWalkFilesOptions,
		): AsyncIterable<SandboxFileEntry> {
			yield* admit('walkFiles').walkFiles(rootPath, walkOptions)
		},

		async openTerminal(
			terminalOptions: KubernetesOpenTerminalOptions,
		): Promise<KubernetesWorkspaceTerminal> {
			// A session terminal goes through the TRANSPORT rather than the
			// inner handle, for the reason `sessionTransports` states: the
			// session ops are the workspace's own surface, and keeping them
			// off the inner handle's automatic-retirement path is what makes
			// "losing a connection costs the workspace nothing" true here too.
			const terminal =
				terminalOptions.sessionId === undefined && terminalOptions.persistent !== true
					? await admitted(
							'openTerminal',
							async (handle) => await handle.openTerminal(terminalOptions),
						)
					: await admitted(
							'openTerminal',
							async (handle) =>
								await admittedTransport('openTerminal', handle).openTerminal(terminalOptions),
						)
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

		async attachTerminal(
			sessionId: string,
			attachOptions?: KubernetesAttachTerminalOptions,
		): Promise<KubernetesSessionTerminal> {
			const terminal = await admitted(
				'attachTerminal',
				async (handle) =>
					await admittedTransport('attachTerminal', handle).attachSession(sessionId, attachOptions),
			)
			// Tracked exactly like an `openTerminal` result, and released the
			// same way: a suspend detaches it rather than killing the shell.
			terminals.add(terminal)
			void terminal.exited
				.finally(() => {
					terminals.delete(terminal)
				})
				.catch(() => undefined)
			return terminal
		},

		async startDetached(
			detachedOptions: KubernetesStartDetachedOptions,
		): Promise<KubernetesSessionSummary> {
			return await admitted(
				'startDetached',
				async (handle) =>
					await admittedTransport('startDetached', handle).startDetached(detachedOptions),
			)
		},

		async readSession(
			sessionId: string,
			readOptions?: KubernetesReadSessionOptions,
		): Promise<KubernetesSessionOutput> {
			return await admitted(
				'readSession',
				async (handle) =>
					await admittedTransport('readSession', handle).readSession(sessionId, readOptions),
			)
		},

		async listSessions(
			transitionOptions?: KubernetesWorkspaceTransitionOptions,
		): Promise<readonly KubernetesSessionSummary[]> {
			return await admitted(
				'listSessions',
				async (handle) =>
					await admittedTransport('listSessions', handle).listSessions(transitionOptions?.signal),
			)
		},

		async killSession(
			sessionId: string,
			killOptions?: KubernetesKillSessionOptions,
		): Promise<KubernetesSessionSummary> {
			return await admitted(
				'killSession',
				async (handle) =>
					await admittedTransport('killSession', handle).killSession(sessionId, killOptions ?? {}),
			)
		},

		async openTcpConnection(
			connectOptions: SandboxTcpConnectOptions,
		): Promise<SandboxTcpConnection> {
			return await admitted(
				'openTcpConnection',
				async (handle) => await handle.openTcpConnection(connectOptions),
			)
		},

		async refresh(transitionOptions?: KubernetesWorkspaceTransitionOptions): Promise<void> {
			// Serialised, unlike the call-failure path, because nothing calls
			// this from inside a transition: it is a caller's own verb, and
			// running it between transitions rather than through one keeps it
			// from reading a mode a resume is halfway through changing.
			await serialise(async () => {
				await noticeSuspendedElsewhere(transitionOptions?.signal)
			})
		},

		async quiesce(quiesceOptions?: KubernetesQuiesceOptions): Promise<KubernetesQuiesceReport> {
			// Serialised, like the transitions it is meant to precede: a quiesce
			// racing the suspend that follows it would be a quiesce of a pod the
			// patch has already taken away, and one racing a resume would ask
			// the old pod to stop the new one's processes.
			return await serialise(async () => await quiesceNow(quiesceOptions))
		},

		async suspend(transitionOptions?: KubernetesWorkspaceSuspendOptions): Promise<void> {
			// The single flight takes the FIRST caller's epoch, exactly as it
			// takes the first caller's signal: a second caller arriving
			// mid-suspend is joining that transition rather than starting one
			// of its own, and one transition can only be written under one
			// authority. Its `quiesce` is the exception `suspendShared`
			// explains — a guarantee about the guest, not an authority, and
			// one a transition already patching cannot be given.
			await suspendShared(
				transitionOptions?.signal,
				assertHolderEpoch(transitionOptions?.epoch, 'suspend') ?? heldEpoch,
				transitionOptions?.quiesce,
			)
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
			await serialise(
				async () =>
					await resumeNow(
						transitionOptions?.signal,
						transitionOptions?.onStartFailure ?? defaultStartFailure,
						assertHolderEpoch(transitionOptions?.epoch, 'resume') ?? heldEpoch,
						transitionOptions?.refreshPodTemplate === true,
					),
			)
		},

		async destroy(destroyOptions?: KubernetesWorkspaceDestroyOptions): Promise<void> {
			assertHolderEpoch(destroyOptions?.epoch, 'destroy')
			if (destroyOptions?.deleteDisk !== true) {
				// The default, and the whole point of the default: there is no
				// delete-compute-keep-disk verb, so the closest thing to one is
				// a suspend, and `destroy()` in a `finally` must not erase a
				// workspace nobody asked to erase. It shares the suspend's
				// single flight, so `destroy()` racing `suspend()` is one
				// transition rather than two — and it stays idempotent over a
				// workspace already deleted, where `suspend()` itself refuses.
				await destroyBySuspending(
					destroyOptions?.signal,
					destroyOptions?.epoch ?? heldEpoch,
					destroyOptions?.quiesce,
				)
				return
			}
			await deleteShared(destroyOptions)
		},
	}
}
