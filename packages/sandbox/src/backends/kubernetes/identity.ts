/**
 * What a Kubernetes workspace handle is bound to, and what it says when the
 * thing behind the name changes underneath it.
 *
 * Its own module for one structural reason: `workspace.ts` owns the handle
 * and `transport.ts` owns the rebind that follows a replaced pod, the
 * workspace imports the transport, and the refusal the transport has to
 * carry back out belongs to neither of them alone. Putting these here is
 * what lets the rebind routine rethrow a workspace-level verdict without
 * `transport.ts` importing the file that imports it.
 *
 * Nothing in here reaches `@namzu/sdk`'s `Sandbox`. A handle's identity is a
 * Kubernetes fact — a Sandbox uid, a PVC uid, a pod uid — and a tier with no
 * such objects has nothing to answer.
 */

import { RemoteCancellationUnknownError } from '../remote-execution-controller.js'

/**
 * The four objects a workspace handle is holding at once.
 *
 * Read as a set rather than one at a time, because the QUESTION a host has is
 * never about one of them: "is the work I did still there" is answered by the
 * disk (`sandboxUid` and `volumeClaimUids`), and "are the processes I started
 * still there" by the guest (`podUid` and `guestBootId`). The two can move
 * independently and each moving means something different.
 *
 *  - `sandboxUid` — the Sandbox object itself. A workspace deleted and
 *    recreated under the same id gets a new one, and an empty disk with it.
 *    Undefined only if the API server answered the handle's reads without a
 *    `metadata.uid`, which no real one does.
 *  - `volumeClaimUids` — one entry per `volumeClaimTemplates` entry NAME,
 *    holding that PVC's uid. Empty when the Role does not grant `get` on
 *    `persistentvolumeclaims`: the disk identity is reported when it can be
 *    read and the workspace works either way, rather than every create
 *    failing on a verb an existing deployment's Role does not have.
 *  - `podUid` — the live pod, and the agent's bind token. `undefined` exactly
 *    when the handle is bound to no pod: a suspended or destroyed workspace,
 *    and the window a `suspend()` opens between giving its pod back and a
 *    `resume()` binding the next one. It is NOT blanked for the length of a
 *    transition — a resume that has bound its pod and is probing it names
 *    that pod, because that is the pod every answer in that window is about.
 *  - `guestBootId` — the agent PROCESS inside that pod. `undefined` wherever
 *    `podUid` is, against a guest too old to report one (which is why nothing
 *    may require it), and until the pod it names has answered once. A changed
 *    value with an unchanged `podUid` is a container the kubelet restarted in
 *    place: same pod, same token, and every process the caller started gone.
 */
export interface KubernetesWorkspaceIdentity {
	readonly sandboxUid: string | undefined
	readonly volumeClaimUids: Readonly<Record<string, string>>
	readonly podUid: string | undefined
	readonly guestBootId: string | undefined
}

/**
 * Why the guest a handle is talking to is not the guest it was talking to.
 *
 *  - `pod-replaced` — a different pod. The controller replaced it (a resume
 *    the handle did not make, an eviction, a node drain), and the handle has
 *    rebound to it with a new bind token.
 *  - `container-restarted` — the same pod, a different agent process. The
 *    kubelet restarted the container in place, so nothing about the address
 *    or the token changed and only the boot id says the guest did.
 */
export type KubernetesGuestRestartReason = 'pod-replaced' | 'container-restarted'

/**
 * One guest restart, delivered to every
 * {@link KubernetesWorkspace.onGuestRestart} listener.
 *
 * `previous` and `current` are whole identities rather than the one field
 * that moved: a listener deciding what of its own state to throw away needs
 * to know what did NOT move as much as what did.
 *
 * Both halves name a pod, ALWAYS, and that is a promise about the payload
 * rather than about the handle: they are built from the uids the routine
 * announcing the move is holding, never read back off a handle that may be
 * in the middle of a transition. The event a host is most likely to act on
 * is the one raised while a `resume()` is still in flight — somebody else's
 * replacement, found by the privilege probe — and an identity assembled from
 * the handle's state would announce a pod replacement there while naming
 * neither pod.
 *
 * On `pod-replaced`, `current.guestBootId` is `undefined` — the replacement
 * has not answered yet, and naming a process nobody has heard from would be a
 * guess. `current.podUid` is the field that moved, and the process that
 * answers from that pod is in `workspace.identity` once the call that
 * rebound has returned. On `container-restarted` the pod did not move and
 * both boot ids are present.
 */
export interface KubernetesGuestRestart {
	readonly reason: KubernetesGuestRestartReason
	readonly previous: KubernetesWorkspaceIdentity
	readonly current: KubernetesWorkspaceIdentity
}

/**
 * Thrown instead of rebinding when the object behind the workspace's name is
 * not the object this handle was opened on.
 *
 * The distinction this class exists for is the whole reason a rebind is
 * allowed at all. Following a REPLACED POD is safe: the Sandbox is the same
 * object, so the disk behind it is the same disk and the work the caller did
 * is still there. Following a replaced SANDBOX is not: the name is
 * deterministic, so a workspace deleted and recreated stands under it with an
 * empty disk, and a handle that silently carried on would write a caller's
 * next file into a workspace its records say holds a month of work.
 *
 * So this is terminal for the handle: nothing retries it, nothing rebinds
 * after it, and the way forward is to open a new handle and decide what the
 * new disk is worth.
 */
export class KubernetesWorkspaceReplacedError extends Error {
	override readonly name = 'KubernetesWorkspaceReplacedError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
		/** The Sandbox uid this handle was opened on. */
		readonly expectedSandboxUid: string | undefined,
		/**
		 * The uid standing under that name now — `undefined` when there is no
		 * Sandbox there at all any more.
		 */
		readonly actualSandboxUid: string | undefined,
		options?: ErrorOptions,
	) {
		super(
			actualSandboxUid === undefined
				? `kubernetes: workspace ${workspaceId} (Sandbox ${sandboxName}, uid ${String(
						expectedSandboxUid,
					)}) no longer exists — the guest refused this handle's bind token and a re-read found no Sandbox of that name. Somebody deleted it, and a DELETE cascades to the disk. This handle is finished: it will not rebind, because there is nothing to rebind TO, and the failed call's outcome in the pod that is gone is unknown. Open a new workspace with the same id to get a fresh object with an empty disk.`
				: `kubernetes: workspace ${workspaceId} (Sandbox ${sandboxName}) is a DIFFERENT object than the one this handle was opened on — it holds uid ${actualSandboxUid} where this handle bound uid ${String(
						expectedSandboxUid,
					)}. The name is deterministic, so somebody deleted the workspace and created it again under it; the disk behind the name is a new, empty disk and none of this handle's work is on it. This handle deliberately did NOT rebind to it — a call that silently succeeded against it would write into a workspace whose records say it holds the old one's work. Open a new handle and decide what the new disk is worth.`,
			options,
		)
	}
}

/**
 * What a bounded look at the guest found after a cancellation could not be
 * confirmed — the identity half of the diagnosis, beside the `healthz` half.
 *
 *  - `same-guest` — the pod this handle is bound to is still the live pod and
 *    the agent process is the one it has been talking to. A command of
 *    unknown state may genuinely still be running in it.
 *  - `pod-replaced` — a live pod stands under the name with a DIFFERENT uid.
 *    The pod that ran the command is gone, and everything in its pid
 *    namespace went with it.
 *  - `pod-gone` — no live pod under the name at all.
 *  - `container-restarted` — the same pod, a different agent process: the
 *    kubelet restarted the container, so the command's process tree is gone
 *    even though the address and the token still work.
 *  - `unknown` — the look itself could not be completed (the API read failed,
 *    or its own short deadline expired). Nothing may be concluded from it.
 */
export type KubernetesGuestEvidence =
	| 'same-guest'
	| 'pod-replaced'
	| 'pod-gone'
	| 'container-restarted'
	| 'unknown'

/**
 * A cancellation that could not be confirmed, raised against a guest that is
 * demonstrably no longer there.
 *
 * It extends {@link RemoteCancellationUnknownError} rather than replacing it,
 * and that is the point: every host already catching the base class goes on
 * catching this, the `retirement` observation still rides on it, and the rule
 * it states is unchanged — **the command's outcome is unknown and it must not
 * be retried automatically**. What this adds is the EVIDENCE, which the base
 * class cannot carry: which guest the command was started on, which guest is
 * there now, and how they differ.
 *
 * It changes nothing about the cluster. No patch is sent on this path — a
 * `Suspended` patch cannot stop a command whose pod is already gone, and
 * would only take the replacement away from every other holder — so a
 * `Running` workspace stays `Running` and `suspended` stays `false`, and the
 * next call rebinds to the live pod on its own.
 *
 * `previous` is the guest the COMMAND was running in — the pod its
 * reservation was accepted by and the agent process inside it — and not
 * whatever the handle is bound to by the time the diagnosis runs. The two
 * differ exactly when it matters: the failing call's own `cancel-execution`
 * refusal already told the handle about a restarted container, and another
 * call may already have rebound the handle to the replacement pod. `current`
 * is what stands under the workspace name now, and it names an agent process
 * only when that process belongs to the pod it names — a pod nobody has heard
 * from reports `guestBootId: undefined` rather than borrowing another pod's.
 *
 * It is never how a FOREIGN SUSPEND is reported, even though a suspended
 * workspace has no pod either and produces the same evidence. That case
 * leaves as `KubernetesWorkspaceSuspendedError` instead: the handle adopts
 * the suspension, so `suspended` reads `true` and `resume()` brings a pod
 * back — a recovery this error has no way to offer.
 */
export class KubernetesWorkspaceGuestGoneError extends RemoteCancellationUnknownError {
	override readonly name = 'KubernetesWorkspaceGuestGoneError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
		/** See {@link KubernetesGuestEvidence} — never `same-guest` here. */
		readonly evidence: KubernetesGuestEvidence,
		readonly previous: KubernetesWorkspaceIdentity,
		readonly current: KubernetesWorkspaceIdentity,
		options?: ErrorOptions,
	) {
		super(
			`kubernetes: a command on workspace ${workspaceId} (Sandbox ${sandboxName}) could not have its cancellation confirmed, and the guest it was running in is gone: ${describeEvidence(
				evidence,
			)} (${describeMove(previous, current)}). The command's outcome is UNKNOWN — nothing on this side ever saw it end — so it must not be retried automatically; whatever it had already written to the disk is on the disk. Nothing was patched from here: no Suspended patch was sent, the workspace still holds its disk, and the next call binds to whatever pod stands under the name. Every process the command's guest was running, this command included, is gone with it.`,
			options,
		)
	}
}

/**
 * What moved between the guest the command RESERVED on and the guest standing
 * there now, said without ever printing a value neither identity holds.
 *
 * Both halves of each identity come from the same pod by construction, so
 * this only has to render them: an absent `podUid` is no pod at all, and an
 * absent `guestBootId` on `current` is a pod nothing has answered from yet —
 * never a process this handle happens to know about in some other pod.
 *
 * "No pod" is spelled out on BOTH sides rather than stringified. Every
 * caller here guards on a bound pod before it builds a diagnosis, so an
 * absent `previous.podUid` should not arrive — and a sentence reading "pod
 * undefined, unchanged" is the kind of thing an operator quotes back, so it
 * is worded rather than left to `String`.
 */
function describeMove(
	previous: KubernetesWorkspaceIdentity,
	current: KubernetesWorkspaceIdentity,
): string {
	const was = previous.podUid ?? 'no pod this handle could name'
	const pod =
		previous.podUid === current.podUid
			? `pod ${was}, unchanged`
			: `pod ${was} → ${current.podUid ?? 'no pod under the name'}`
	if (previous.guestBootId === undefined && current.guestBootId === undefined) {
		return `${pod}; this guest reports no boot id, so its agent process cannot be named`
	}
	if (previous.guestBootId === current.guestBootId)
		return `${pod}, agent ${String(current.guestBootId)}, unchanged`
	return `${pod}, agent ${previous.guestBootId ?? 'unknown'} → ${current.guestBootId ?? 'nothing has answered from there yet'}`
}

function describeEvidence(evidence: KubernetesGuestEvidence): string {
	if (evidence === 'pod-replaced') return 'a different pod stands under the workspace name'
	if (evidence === 'pod-gone') return 'no live pod stands under the workspace name'
	if (evidence === 'container-restarted') {
		return 'the same pod is running a different agent process, so its container was restarted in place'
	}
	if (evidence === 'unknown') return 'the guest could not be identified at all'
	return 'the guest is unchanged'
}
