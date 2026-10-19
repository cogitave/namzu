/**
 * Looking at a retained workspace by its exact identity, without creating,
 * waking or writing anything.
 *
 * `createKubernetesWorkspace` is create-or-adopt: handed an id it POSTs, and
 * on a 409 adopts whatever stands there and resumes it. That is the right
 * verb for "give me a workspace" and the wrong one for a host that restarted
 * and wants to know whether the workspace it recorded last week is still the
 * workspace under that name — the question has to be answered BEFORE a pod is
 * started for what might be a stranger's disk.
 *
 * Three verbs, all GET-only:
 *
 *  - {@link inspectKubernetesWorkspace} — what is there, and who holds it.
 *  - {@link openKubernetesWorkspace} — authenticate a retained identity, and
 *    optionally wait, under one deadline, for its claims and its guest.
 *  - {@link reconcileKubernetesWorkspace} — after a restart: live, suspended,
 *    absent or replaced.
 *
 * ## Ownership and readiness are separate questions
 *
 * Ownership is decided by uids and by nothing else: the Sandbox's
 * `metadata.uid`, each volume claim's uid, and who owns each claim. A
 * `resourceVersion` that moved, a `Ready` condition that flipped and a
 * condition left over from an earlier generation are the controller working,
 * and none of them is ever read as a change of owner. Readiness is a bounded
 * poll on top of an ownership check that runs again on every pass, so a
 * replacement that lands while waiting is still a refusal.
 */

import { OperationDeadline, OperationDeadlineExpired } from '../readiness.js'
import {
	type KubernetesWorkspaceExpectedIdentity,
	type KubernetesWorkspaceIdentity,
	type KubernetesWorkspaceIdentityMismatch,
	KubernetesWorkspaceIdentityMismatchError,
} from './identity.js'
import {
	type KubernetesBackendInternalConfig,
	clientAccess,
	clientOptions,
	resolveKubernetesReadiness,
} from './index.js'
import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	createKubernetesClient,
} from './k8s-client.js'
import {
	type KubernetesCondition,
	type PodResource,
	READY_CONDITION,
	type SandboxResource,
	isPodLive,
	persistentVolumeClaimPath,
	podPath,
	readHolderEpoch,
	sandboxPath,
} from './objects.js'
import {
	KubernetesWorkspacePreconditionError,
	assertHolderEpoch,
	workspaceSandboxName,
} from './workspace.js'

/** What every verb here takes besides its own fields. */
export interface KubernetesWorkspaceObservationOptions {
	readonly signal?: AbortSignal
}

/** {@link inspectKubernetesWorkspace}'s options. */
export interface KubernetesWorkspaceInspectOptions extends KubernetesWorkspaceObservationOptions {
	/**
	 * The holder epoch this reader acts under. A workspace held at a HIGHER
	 * epoch refuses it with `KubernetesWorkspacePreconditionError`: a
	 * superseded host must not conclude anything about a workspace that
	 * belongs to another process now. Nothing is written either way.
	 */
	readonly epoch: number
}

/** What one read-only look at a workspace found. */
export interface KubernetesWorkspaceInspection {
	readonly workspaceId: string
	readonly sandboxName: string
	readonly operatingMode: 'Running' | 'Suspended'
	/**
	 * The disk and the guest, as the cluster reports them now.
	 * `volumeClaimUids` holds the claims that exist; `podUid` is the live pod
	 * and is `undefined` for a suspended workspace; `guestBootId` is always
	 * `undefined` — nothing here dials the guest.
	 */
	readonly identity: KubernetesWorkspaceIdentity
	/** The stored holder epoch; `0` for a workspace that never carried one. */
	readonly holderEpoch: number
	/**
	 * The Sandbox reports `Ready` for its CURRENT generation AND a live pod
	 * stands under it. A `Ready: True` the controller wrote for an earlier
	 * generation does not count.
	 */
	readonly ready: boolean
	/** `volumeClaimTemplates` entries whose PVC does not exist (yet). */
	readonly missingVolumeClaims: readonly string[]
}

/** {@link openKubernetesWorkspace}'s options. */
export interface KubernetesWorkspaceOpenOptions extends KubernetesWorkspaceObservationOptions {
	readonly workspaceId: string
	/** The identity the host retained. The Sandbox uid is required. */
	readonly identity: KubernetesWorkspaceExpectedIdentity
	/** The holder epoch this host acts under — see {@link KubernetesWorkspaceInspectOptions.epoch}. */
	readonly epoch: number
	/**
	 * Poll, under ONE deadline (`readyTimeoutMs`), until every volume claim
	 * exists and the guest is ready. A suspended workspace is returned at
	 * once — opening never wakes anything, so there is nothing to wait for.
	 * Omitted or `false`, one pass is made and the result says what was
	 * missing.
	 */
	readonly waitForReady?: boolean
}

/** {@link reconcileKubernetesWorkspace}'s options. */
export interface KubernetesWorkspaceReconcileOptions extends KubernetesWorkspaceObservationOptions {
	readonly workspaceId: string
	readonly identity: KubernetesWorkspaceExpectedIdentity
	/** When given, a workspace held at a higher epoch refuses the reconcile. */
	readonly epoch?: number
}

/**
 * What stands under a retained identity now.
 *
 *  - `live` — the same Sandbox, `Running`.
 *  - `suspended` — the same Sandbox, `Suspended`; its disk is intact.
 *  - `absent` — no Sandbox stands under the name at all.
 *  - `replaced` — a different Sandbox, or a different volume claim, stands
 *    there; `mismatch` says which. The retained workspace is gone.
 */
export type KubernetesWorkspaceClosureState = 'live' | 'suspended' | 'absent' | 'replaced'

export interface KubernetesWorkspaceClosure {
	readonly state: KubernetesWorkspaceClosureState
	readonly workspaceId: string
	readonly sandboxName: string
	/** What was observed. Absent for `absent`; the STRANGER's for `replaced`. */
	readonly identity?: KubernetesWorkspaceIdentity
	/** Why the state is `replaced`. */
	readonly mismatch?: KubernetesWorkspaceIdentityMismatch
}

/** The wait ran out before the workspace was ready. Ownership was never in doubt. */
export class KubernetesWorkspaceReadyTimeoutError extends Error {
	override readonly name = 'KubernetesWorkspaceReadyTimeoutError'

	constructor(
		readonly workspaceId: string,
		readonly sandboxName: string,
		readonly timeoutMs: number,
		/** What the last pass was still waiting for. */
		readonly waitingFor: readonly ('volume-claims' | 'ready-condition' | 'pod')[],
		/** The last pass, so a caller can see how far it got. */
		readonly lastObserved: KubernetesWorkspaceInspection,
	) {
		super(
			`kubernetes: workspace ${workspaceId} (Sandbox ${sandboxName}) was the retained workspace on every pass but was not ready ${timeoutMs}ms later — still waiting for ${waitingFor.join(', ')}. Ownership is not in question: this is the controller not having finished, and nothing was created or woken to hurry it.`,
		)
	}
}

interface ObservedClaim {
	readonly uid: string
	readonly ownedByOtherSandbox: boolean
}

interface Observation {
	readonly sandbox: SandboxResource
	readonly sandboxUid: string | undefined
	readonly claims: ReadonlyMap<string, ObservedClaim>
	readonly claimNames: readonly string[]
	readonly pod: PodResource | undefined
}

async function readOrGone<T>(
	client: KubernetesClient,
	path: string,
	signal: AbortSignal | undefined,
): Promise<T | undefined> {
	try {
		return await client.request<T>('GET', path, undefined, signal)
	} catch (err) {
		if (err instanceof KubernetesAlreadyGoneError) return undefined
		throw err
	}
}

/**
 * One GET pass: the Sandbox, each of its claims, the pod behind the name.
 * `undefined` is "no Sandbox"; every other failure travels out as itself, so
 * a read that did not answer is never reported as a workspace that is gone.
 */
async function observe(
	client: KubernetesClient,
	namespace: string,
	name: string,
	signal: AbortSignal | undefined,
): Promise<Observation | undefined> {
	const sandbox = await readOrGone<SandboxResource>(client, sandboxPath(namespace, name), signal)
	if (sandbox === undefined) return undefined
	const sandboxUid = sandbox.metadata?.uid
	const claims = new Map<string, ObservedClaim>()
	const claimNames: string[] = []
	for (const entry of sandbox.spec?.volumeClaimTemplates ?? []) {
		const claimName = entry?.metadata?.name
		if (typeof claimName !== 'string' || claimName === '') continue
		claimNames.push(claimName)
		const claim = await readOrGone<{ metadata?: SandboxResource['metadata'] }>(
			client,
			persistentVolumeClaimPath(namespace, name, claimName),
			signal,
		)
		const uid = claim?.metadata?.uid
		if (typeof uid !== 'string' || uid === '') continue
		const owners = claim?.metadata?.ownerReferences ?? []
		// Only a claim that NAMES owners and names none of them this Sandbox is
		// foreign; one with no owner list says nothing, and refusing it would
		// refuse a cluster that simply does not report them.
		const foreign =
			sandboxUid !== undefined && owners.length > 0 && !owners.some((o) => o?.uid === sandboxUid)
		claims.set(claimName, { uid, ownedByOtherSandbox: foreign })
	}
	const pod = await readOrGone<PodResource>(client, podPath(namespace, name), signal)
	return { sandbox, sandboxUid, claims, claimNames, pod }
}

function operatingModeOf(sandbox: SandboxResource): 'Running' | 'Suspended' {
	return sandbox.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running'
}

/**
 * `Ready` is true AND is about the object's current spec. The controller
 * keeps a `Ready: True` it wrote for an earlier generation visible after a
 * spec change, and reading that as the new outcome is how a wake gets
 * reported ready while its pod is still being replaced.
 */
function isReadyForCurrentGeneration(sandbox: SandboxResource): boolean {
	const condition: KubernetesCondition | undefined = sandbox.status?.conditions?.find(
		(c) => c.type === READY_CONDITION,
	)
	if (condition?.status !== 'True') return false
	const generation = sandbox.metadata?.generation
	const observed = condition.observedGeneration
	return !(generation !== undefined && observed !== undefined && observed < generation)
}

function inspectionOf(
	workspaceId: string,
	name: string,
	seen: Observation,
): KubernetesWorkspaceInspection {
	const livePod = isPodLive(seen.pod) ? seen.pod : undefined
	const podUid = livePod?.metadata?.uid
	const uids: Record<string, string> = {}
	for (const [claimName, claim] of seen.claims) uids[claimName] = claim.uid
	const mode = operatingModeOf(seen.sandbox)
	return {
		workspaceId,
		sandboxName: name,
		operatingMode: mode,
		identity: {
			sandboxUid: seen.sandboxUid,
			volumeClaimUids: uids,
			podUid: mode === 'Suspended' ? undefined : podUid,
			guestBootId: undefined,
		},
		holderEpoch: readHolderEpoch(seen.sandbox.metadata).epoch ?? 0,
		ready:
			mode === 'Running' &&
			isReadyForCurrentGeneration(seen.sandbox) &&
			typeof podUid === 'string' &&
			podUid !== '',
		missingVolumeClaims: seen.claimNames.filter((n) => !seen.claims.has(n)),
	}
}

interface Mismatch {
	readonly kind: KubernetesWorkspaceIdentityMismatch
	readonly expected: string | undefined
	readonly actual: string | undefined
	readonly claim?: string
}

/**
 * The first way `seen` is not the retained workspace, or `undefined`.
 *
 * `claimUids` is every claim uid trusted so far: the retained ones, and every
 * one a previous pass of the same wait saw. A claim that is not there yet is
 * not a mismatch; one that is there with a DIFFERENT uid than one already
 * trusted is.
 */
function firstMismatch(
	retained: KubernetesWorkspaceExpectedIdentity,
	claimUids: Record<string, string>,
	seen: Observation,
): Mismatch | undefined {
	if (seen.sandboxUid !== retained.sandboxUid) {
		return { kind: 'sandbox-uid', expected: retained.sandboxUid, actual: seen.sandboxUid }
	}
	for (const [claimName, claim] of seen.claims) {
		const trusted = claimUids[claimName]
		if (trusted !== undefined && trusted !== claim.uid) {
			return { kind: 'volume-claim-uid', expected: trusted, actual: claim.uid, claim: claimName }
		}
		if (claim.ownedByOtherSandbox) {
			return {
				kind: 'volume-claim-owner',
				expected: retained.sandboxUid,
				actual: claim.uid,
				claim: claimName,
			}
		}
	}
	return undefined
}

function assertRetained(identity: KubernetesWorkspaceExpectedIdentity, where: string): void {
	if (typeof identity?.sandboxUid !== 'string' || identity.sandboxUid === '') {
		throw new TypeError(
			`kubernetes: ${where} needs identity.sandboxUid, a non-empty string — without it there is nothing to authenticate.`,
		)
	}
}

function assertEpochAllows(
	operation: string,
	workspaceId: string,
	name: string,
	epoch: number,
	sandbox: SandboxResource,
): void {
	const reading = readHolderEpoch(sandbox.metadata)
	if (reading.epoch !== undefined && reading.epoch <= epoch) return
	throw new KubernetesWorkspacePreconditionError(
		operation,
		workspaceId,
		name,
		epoch,
		reading.epoch,
		reading.annotation,
	)
}

function clientFor(config: KubernetesBackendInternalConfig): KubernetesClient {
	return createKubernetesClient(clientAccess(config), clientOptions(config))
}

/**
 * Read what stands under a workspace id: its Sandbox uid, its claim uids, its
 * pod and its operating mode, and who holds it. GET requests only — nothing
 * is created, woken, patched or deleted — and `undefined` when no Sandbox
 * stands there.
 *
 * Needs `get` on `sandboxes`, `persistentvolumeclaims` and `pods`. A failed
 * read rejects as itself: an unanswered request is never reported as a
 * workspace that is absent.
 */
export async function inspectKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	workspaceId: string,
	options: KubernetesWorkspaceInspectOptions,
): Promise<KubernetesWorkspaceInspection | undefined> {
	options.signal?.throwIfAborted()
	const epoch = assertHolderEpoch(options.epoch, 'inspectKubernetesWorkspace')
	if (epoch === undefined) {
		throw new TypeError('kubernetes: inspectKubernetesWorkspace needs an epoch.')
	}
	const name = workspaceSandboxName(workspaceId)
	const seen = await observe(clientFor(config), config.namespace, name, options.signal)
	if (seen === undefined) return undefined
	assertEpochAllows('inspectKubernetesWorkspace', workspaceId, name, epoch, seen.sandbox)
	return inspectionOf(workspaceId, name, seen)
}

/**
 * Authenticate a retained identity against what stands under the workspace
 * id, and — with `waitForReady` — wait for it to be usable. Never creates,
 * wakes or writes.
 *
 * Refuses with {@link KubernetesWorkspaceIdentityMismatchError} when the
 * Sandbox is gone or has another uid, or a claim has another uid or another
 * owner, and with `KubernetesWorkspacePreconditionError` when the workspace
 * is held at a higher epoch. The waiting form repeats both checks on every
 * pass and retains every claim uid it has seen, so a replacement that lands
 * mid-wait is a refusal rather than a longer wait. Cancelling `signal`
 * rejects with its reason; running out of `readyTimeoutMs` rejects with
 * {@link KubernetesWorkspaceReadyTimeoutError}. The three never share a class.
 */
export async function openKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceOpenOptions,
): Promise<KubernetesWorkspaceInspection> {
	options.signal?.throwIfAborted()
	const { workspaceId } = options
	assertRetained(options.identity, 'openKubernetesWorkspace')
	const epoch = assertHolderEpoch(options.epoch, 'openKubernetesWorkspace')
	if (epoch === undefined)
		throw new TypeError('kubernetes: openKubernetesWorkspace needs an epoch.')
	const name = workspaceSandboxName(workspaceId)
	const client = clientFor(config)
	const trusted: Record<string, string> = { ...(options.identity.volumeClaimUids ?? {}) }
	const wait = options.waitForReady === true
	const readiness = resolveKubernetesReadiness(config)
	const deadline = new OperationDeadline(
		readiness.timeoutMs,
		`kubernetes workspace ${name} open`,
		options.signal,
	)

	const pass = async (signal: AbortSignal | undefined): Promise<KubernetesWorkspaceInspection> => {
		const seen = await observe(client, config.namespace, name, signal)
		if (seen === undefined) {
			throw new KubernetesWorkspaceIdentityMismatchError(
				workspaceId,
				name,
				'sandbox-absent',
				options.identity.sandboxUid,
				undefined,
			)
		}
		const mismatch = firstMismatch(options.identity, trusted, seen)
		if (mismatch !== undefined) {
			throw new KubernetesWorkspaceIdentityMismatchError(
				workspaceId,
				name,
				mismatch.kind,
				mismatch.expected,
				mismatch.actual,
				mismatch.claim,
			)
		}
		assertEpochAllows('openKubernetesWorkspace', workspaceId, name, epoch, seen.sandbox)
		for (const [claimName, claim] of seen.claims) trusted[claimName] = claim.uid
		return inspectionOf(workspaceId, name, seen)
	}

	if (!wait) return await pass(options.signal)

	let last: KubernetesWorkspaceInspection | undefined
	while (deadline.remainingMs() > 0) {
		try {
			last = await deadline.run((signal) => pass(signal))
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
		if (last.operatingMode === 'Suspended') return last
		if (last.missingVolumeClaims.length === 0 && last.ready) return last
		try {
			await deadline.delay(readiness.pollIntervalMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	options.signal?.throwIfAborted()
	if (last === undefined) {
		// The deadline expired before the first pass answered. That is an
		// unanswered read, not a workspace that is not ready, and it is said so.
		throw new OperationDeadlineExpired(`kubernetes workspace ${name} open`)
	}
	throw new KubernetesWorkspaceReadyTimeoutError(
		workspaceId,
		name,
		readiness.timeoutMs,
		[
			...(last.missingVolumeClaims.length > 0 ? (['volume-claims'] as const) : []),
			...(last.identity.podUid === undefined ? (['pod'] as const) : []),
			...(last.ready ? [] : (['ready-condition'] as const)),
		],
		last,
	)
}

/**
 * After a restart: what became of the workspace a host retained? One
 * GET-only pass, answered as a closure state rather than thrown.
 *
 * A different Sandbox or claim is `replaced`, not an error, because for a
 * host closing its books that IS the answer. A read that did not answer
 * rejects as itself — it is never mapped to `absent`.
 */
export async function reconcileKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceReconcileOptions,
): Promise<KubernetesWorkspaceClosure> {
	options.signal?.throwIfAborted()
	const { workspaceId } = options
	assertRetained(options.identity, 'reconcileKubernetesWorkspace')
	const epoch = assertHolderEpoch(options.epoch, 'reconcileKubernetesWorkspace')
	const name = workspaceSandboxName(workspaceId)
	const seen = await observe(clientFor(config), config.namespace, name, options.signal)
	if (seen === undefined) return { state: 'absent', workspaceId, sandboxName: name }
	const inspection = inspectionOf(workspaceId, name, seen)
	const mismatch = firstMismatch(
		options.identity,
		{ ...(options.identity.volumeClaimUids ?? {}) },
		seen,
	)
	if (mismatch !== undefined) {
		return {
			state: 'replaced',
			workspaceId,
			sandboxName: name,
			identity: inspection.identity,
			mismatch: mismatch.kind,
		}
	}
	if (epoch !== undefined) {
		assertEpochAllows('reconcileKubernetesWorkspace', workspaceId, name, epoch, seen.sandbox)
	}
	return {
		state: inspection.operatingMode === 'Suspended' ? 'suspended' : 'live',
		workspaceId,
		sandboxName: name,
		identity: inspection.identity,
	}
}
