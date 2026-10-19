/**
 * Allocating a workspace without adopting or waking anything, bound to an
 * allocation the host recorded first.
 *
 * `createKubernetesWorkspace` is create-or-adopt: a 409 turns into "this is
 * mine from before", and the pod may be resumed before it returns. A host
 * that persists its intent BEFORE creating something durable, and has to
 * prove afterwards that what it finds is exactly what it created, needs the
 * opposite verbs:
 *
 *  - {@link resolveKubernetesExecutionProfile} — what a workspace created
 *    from this configuration would run, as content plus one fingerprint.
 *    Creates nothing. The host persists the result, then allocates.
 *  - {@link allocateKubernetesWorkspace} — ONE create request. A same-name
 *    object is a typed conflict and is never touched; the pod is never
 *    resumed; the answer is an acknowledgement carrying the new Sandbox's
 *    uid, not readiness.
 *  - {@link recoverKubernetesWorkspaceAllocation} — the only way out of a
 *    create whose reply never arrived. Read-only.
 *
 * ## Fingerprint canonicalisation
 *
 * The execution profile fingerprint is `sha256:<hex>` of
 * `JSON.stringify(canonical(content))`, where `canonical` sorts the keys of
 * every object by UTF-16 code unit, drops members whose value is
 * `undefined`, keeps arrays in order, and `JSON.stringify` adds no
 * whitespace. `content` is {@link KubernetesExecutionProfile.content}.
 */

import {
	KubernetesExecutionProfileDriftError,
	type KubernetesObservedAllocation,
	type KubernetesWorkspaceAllocation,
	KubernetesWorkspaceAllocationConflictError,
	type KubernetesWorkspaceAllocationMismatch,
	assertAllocation,
	firstAllocationMismatch,
	observedAllocation,
} from './allocation.js'
import {
	assertEgressPolicyIsEnforceable,
	assertEgressProfileIsUsable,
	assertPerSandboxEgressIsUsable,
	composeAdditionalPodLabels,
	perSandboxEgressLabelKey,
} from './egress-policy.js'
import {
	DEFAULT_AGENT_PORT,
	type KubernetesBackendInternalConfig,
	buildEgressBoundary,
	buildIngressVerifier,
	buildSandboxBody,
	clientAccess,
	clientOptions,
	readSandboxTemplate,
	sandboxPodLabels,
} from './index.js'
import { ingressVerificationEnabled, resolveIngressEngine } from './ingress-policy.js'
import {
	KubernetesAlreadyGoneError,
	KubernetesApiError,
	KubernetesApiTimeoutError,
	type KubernetesClient,
	KubernetesConflictError,
	createKubernetesClient,
} from './k8s-client.js'
import {
	ALLOCATION_ID_ANNOTATION_KEY,
	ALLOCATION_SCOPE_ANNOTATION_KEY,
	EXECUTION_PROFILE_ANNOTATION_KEY,
	HOLDER_EPOCH_ANNOTATION_KEY,
	POD_TEMPLATE_HASH_ANNOTATION_KEY,
	type SandboxResource,
	canonicalFingerprint,
	readHolderEpoch,
	sandboxCollectionPath,
	sandboxPath,
} from './objects.js'
import { buildAdmissionFence } from './per-sandbox-policy.js'
import {
	KUBERNETES_PER_SANDBOX_PROFILE_VARIANT,
	perSandboxWorkspaceLabels,
	withoutPerSandboxLabel,
} from './workspace-per-sandbox.js'
import {
	KubernetesWorkspacePreconditionError,
	assertBlockModeWorkspaceDisk,
	assertHolderEpoch,
	buildPodTemplateRefresh,
	workspaceSandboxName,
} from './workspace.js'

/** Bumped when the shape of {@link KubernetesExecutionProfile.content} changes. */
const EXECUTION_PROFILE_CONTENT_VERSION = 1

/** `resolveKubernetesExecutionProfile`'s options. */
export interface KubernetesExecutionProfileOptions {
	/** The SandboxTemplate to resolve; defaults to `config.sandboxTemplateName`. */
	readonly sandboxTemplateName?: string
	/**
	 * The workspace the profile is for. Only read when
	 * `config.egress.perSandbox` is configured: the per-sandbox selector
	 * label's VALUE is the Sandbox's name, so `podTemplateHash` is per
	 * workspace there. Without it that hash is taken over the template
	 * WITHOUT the label, and is not the revision a handle reports. The
	 * fingerprint never depends on it.
	 */
	readonly workspaceId?: string
	readonly signal?: AbortSignal
}

/**
 * What a workspace created from this configuration would run.
 *
 *  - `fingerprint` — `sha256:<hex>` over {@link content}; the value stored
 *    in the profile annotation and the one `expectedAllocation.executionProfile`
 *    carries.
 *  - `podTemplateHash` — the revision of the pod template alone, the same
 *    value `templateRevision` reports on a handle.
 *  - `variant` — `'core/no-network+per-sandbox'` when
 *    `config.egress.perSandbox` is configured over a core `no-network`
 *    baseline, and ABSENT otherwise (over another baseline the content still
 *    changes the fingerprint but claims no name), so the profile of every
 *    configuration that predates the option keeps its fingerprint byte for
 *    byte. Present only after the admission fence that
 *    bounds the host's per-sandbox writes was read and found to enforce:
 *    resolving the profile is how a host learns it is admitted.
 *  - `content` — what was fingerprinted, so a host can persist exactly it:
 *    the pod template after this backend's overlays, the template's volume
 *    claim templates, the egress policy as translated from `config.egress`
 *    (kind, name, manifest — config-derived, not read from the cluster), and
 *    the ingress verification settings.
 */
export interface KubernetesExecutionProfile {
	readonly fingerprint: string
	readonly podTemplateHash: string
	readonly sandboxTemplateName: string
	readonly variant?: typeof KUBERNETES_PER_SANDBOX_PROFILE_VARIANT
	readonly content: Readonly<Record<string, unknown>>
}

interface ProfilePlan {
	readonly client: KubernetesClient
	readonly templateName: string
	readonly profile: KubernetesExecutionProfile
	readonly podLabels: Readonly<Record<string, string>>
	readonly workspacePodLabels: Readonly<Record<string, string>>
	readonly template: Awaited<ReturnType<typeof readSandboxTemplate>>
	readonly boundary: ReturnType<typeof buildEgressBoundary>
}

async function planProfile(
	config: KubernetesBackendInternalConfig,
	sandboxTemplateName: string | undefined,
	signal: AbortSignal | undefined,
	workspaceName?: string,
): Promise<ProfilePlan> {
	assertPerSandboxEgressIsUsable(config.egress)
	assertEgressProfileIsUsable(config.egress)
	if (config.egress) {
		assertEgressPolicyIsEnforceable(
			config.egress.policy,
			config.egress.engine ?? 'core',
			config.egress.ciliumNarrowing,
		)
	}
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const templateName = sandboxTemplateName ?? config.sandboxTemplateName
	const boundary = buildEgressBoundary(client, config, templateName)
	const template = await readSandboxTemplate(client, config.namespace, templateName, signal)
	assertBlockModeWorkspaceDisk(
		`SandboxTemplate ${templateName} in namespace ${config.namespace}`,
		template.podTemplate,
		template.volumeClaimTemplates,
	)
	// Per-sandbox egress: the profile is admitted only when the fence that
	// bounds the host's writes verifies, read here so a configuration whose
	// fence is missing or inert never yields a fingerprint to persist.
	const perSandbox = config.egress?.perSandbox
	if (perSandbox !== undefined) {
		await buildAdmissionFence(client, perSandbox, config.namespace).assertApplied(signal)
	}
	const perSandboxKey = perSandboxEgressLabelKey(config.egress)
	// The variant is named for what it is: a core `no-network` baseline plus
	// per-sandbox widening. Over any other baseline `perSandbox` still
	// changes the fingerprint (it is in the content) but claims no name, so a
	// host that admits only the named variant refuses the rest.
	const carriesVariant =
		perSandbox !== undefined &&
		config.egress?.policy.kind === 'no-network' &&
		(config.egress.engine ?? 'core') === 'core'
	// The label's value is the Sandbox's name, which the profile does not
	// know: the fingerprinted template is built without it, and the body and
	// the revision stamped on the object are built with it.
	const stableLabels = composeAdditionalPodLabels(config.egress)
	const podLabels = composeAdditionalPodLabels(
		config.egress,
		perSandboxKey !== undefined && workspaceName !== undefined
			? { [perSandboxKey]: workspaceName }
			: undefined,
	)
	const stableRefresh = buildPodTemplateRefresh(
		template,
		templateName,
		config.runtimeClassName,
		stableLabels,
	)
	const refresh =
		perSandboxKey !== undefined && workspaceName !== undefined
			? buildPodTemplateRefresh(template, templateName, config.runtimeClassName, podLabels)
			: stableRefresh
	const translated = await boundary?.translatedPolicy()
	const ingressOn = ingressVerificationEnabled(config.ingress)
	const content: Record<string, unknown> = {
		version: EXECUTION_PROFILE_CONTENT_VERSION,
		namespace: config.namespace,
		sandboxTemplateName: templateName,
		podTemplate: stableRefresh.podTemplate,
		volumeClaimTemplates: stableRefresh.volumeClaimTemplates ?? null,
		egress:
			translated === undefined
				? null
				: {
						kind: translated.kind,
						policyKind: translated.policyKind,
						name: translated.name,
						manifest: translated.manifest,
					},
		ingress: ingressOn
			? {
					verified: true,
					engine: resolveIngressEngine(config.ingress, config.egress?.engine),
					agentPort: config.agentPort ?? DEFAULT_AGENT_PORT,
				}
			: { verified: false },
		// Absent without perSandbox, so an existing profile's fingerprint is
		// unchanged. With it, the variant name and everything the host's
		// per-sandbox writes depend on: a fence renamed, a different
		// permitted-hosts ConfigMap or another selector key is another
		// profile, and a workspace allocated under one is not adopted under
		// the other.
		...(perSandbox !== undefined && perSandboxKey !== undefined
			? {
					...(carriesVariant ? { variant: KUBERNETES_PER_SANDBOX_PROFILE_VARIANT } : {}),
					perSandbox: {
						engine: perSandbox.engine,
						labelKey: perSandboxKey,
						admissionPolicyName: perSandbox.admissionPolicyName,
						admissionPolicyBindingName:
							perSandbox.admissionPolicyBindingName ?? `${perSandbox.admissionPolicyName}-binding`,
						hostIdentity: perSandbox.hostIdentity ?? null,
						permittedHostsParam: perSandbox.permittedHostsParam ?? null,
						narrowing: perSandbox.narrowing ?? null,
					},
				}
			: {}),
	}
	return {
		client,
		templateName,
		template,
		boundary,
		podLabels,
		workspacePodLabels: sandboxPodLabels(template, templateName, podLabels),
		profile: {
			fingerprint: canonicalFingerprint(content),
			podTemplateHash: refresh.hash,
			sandboxTemplateName: templateName,
			...(carriesVariant ? { variant: KUBERNETES_PER_SANDBOX_PROFILE_VARIANT } : {}),
			content,
		},
	}
}

/**
 * Resolve and fingerprint what a workspace created from `config` would run —
 * the pod template with this backend's overlays, the template's disks, the
 * egress policy translated from `config.egress` and the ingress settings —
 * without creating, waking or writing anything. One GET: the
 * SandboxTemplate.
 *
 * The host persists the result, then passes `fingerprint` as
 * `allocation.executionProfile` to {@link allocateKubernetesWorkspace}, which
 * refuses to create if the profile resolves differently by then.
 */
export async function resolveKubernetesExecutionProfile(
	config: KubernetesBackendInternalConfig,
	options: KubernetesExecutionProfileOptions = {},
): Promise<KubernetesExecutionProfile> {
	options.signal?.throwIfAborted()
	return (
		await planProfile(
			config,
			options.sandboxTemplateName,
			options.signal,
			options.workspaceId !== undefined ? workspaceSandboxName(options.workspaceId) : undefined,
		)
	).profile
}

/** {@link allocateKubernetesWorkspace}'s options. */
export interface KubernetesWorkspaceAllocateOptions {
	readonly workspaceId: string
	readonly allocation: KubernetesWorkspaceAllocation
	/** The holder epoch to create the workspace under; see `createKubernetesWorkspace`. */
	readonly epoch?: number
	readonly sandboxTemplateName?: string
	readonly signal?: AbortSignal
}

/**
 * Acknowledgement that the API server accepted the create. It says the
 * object exists and which one it is; it does not say the pod is scheduled,
 * the disk is bound or the guest answers — open it with
 * `openKubernetesWorkspace({ waitForReady: true })` for that.
 */
export interface KubernetesWorkspaceAllocationReceipt {
	readonly workspaceId: string
	readonly sandboxName: string
	readonly namespace: string
	/** The created Sandbox's `metadata.uid`. */
	readonly sandboxUid: string
	/**
	 * What the object carries. From `allocate` the profile fingerprint is
	 * always present; from recovery it is whatever the annotation holds.
	 */
	readonly allocation: KubernetesWorkspaceAllocation
	readonly epoch?: number
	/** The pod-template revision stored with the object. */
	readonly templateRevision: string
}

/** Why a create's outcome is unknown. */
export type KubernetesAllocationUnknownReason =
	| 'timeout'
	| 'connection'
	| 'server-error'
	| 'aborted'
	| 'unreadable-reply'

/**
 * The create request was sent and no usable reply came back, so the object
 * may or may not exist. The request was NOT retried and will not be: resolve
 * it with {@link recoverKubernetesWorkspaceAllocation}.
 */
export interface KubernetesWorkspaceAllocationUnknown {
	readonly outcome: 'unknown'
	readonly reason: KubernetesAllocationUnknownReason
	readonly workspaceId: string
	readonly sandboxName: string
	/** What was sent, including the resolved profile fingerprint. */
	readonly allocation: Required<KubernetesWorkspaceAllocation>
	readonly epoch?: number
	/** The failure that made it unknown. */
	readonly error: unknown
}

export type KubernetesWorkspaceAllocationResult =
	| { readonly outcome: 'created'; readonly receipt: KubernetesWorkspaceAllocationReceipt }
	| KubernetesWorkspaceAllocationUnknown

function unknownReason(
	err: unknown,
	signal: AbortSignal | undefined,
): KubernetesAllocationUnknownReason | undefined {
	if (err instanceof KubernetesApiTimeoutError) return 'timeout'
	if (signal?.aborted === true) return 'aborted'
	if (err instanceof KubernetesApiError) {
		if (err.transport === 'connect') return 'connection'
		if (err.status !== undefined && err.status >= 500) return 'server-error'
	}
	return undefined
}

/**
 * Create a workspace Sandbox, exactly once, bound to `allocation`. Never
 * adopts, never resumes, never retries.
 *
 * Before the request, and read-only: the same egress and ingress checks
 * `createKubernetesWorkspace` makes, the block-disk check, and — when
 * `allocation.executionProfile` is given — that the profile resolves to it
 * ({@link KubernetesExecutionProfileDriftError} otherwise). A refusal there
 * sends no create.
 *
 * Then ONE POST, which carries the allocation annotations (see the
 * `*_ANNOTATION_KEY` constants), the holder epoch when one is passed, and
 * the pod-template revision:
 *
 *  - 201 → `{ outcome: 'created', receipt }`.
 *  - 409 → {@link KubernetesWorkspaceAllocationConflictError}; the existing
 *    object was not read, touched or woken.
 *  - a timeout, a reset connection, a 5xx or a caller abort after the request
 *    was sent, or a reply with no uid → `{ outcome: 'unknown' }`. The POST is
 *    not repeated.
 *  - any other rejection (401, 403, 404, 4xx) rejects as itself: the server
 *    answered, and nothing was created.
 */
export async function allocateKubernetesWorkspace(
	config: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceAllocateOptions,
): Promise<KubernetesWorkspaceAllocationResult> {
	options.signal?.throwIfAborted()
	const { workspaceId, signal } = options
	assertAllocation(options.allocation, 'allocateKubernetesWorkspace')
	const epoch = assertHolderEpoch(options.epoch, 'allocateKubernetesWorkspace')
	const name = workspaceSandboxName(workspaceId)
	const plan = await planProfile(config, options.sandboxTemplateName, signal, name)
	const { fingerprint } = plan.profile
	if (
		options.allocation.executionProfile !== undefined &&
		options.allocation.executionProfile !== fingerprint
	) {
		throw new KubernetesExecutionProfileDriftError(
			workspaceId,
			options.allocation.executionProfile,
			fingerprint,
		)
	}
	// The same pre-create checks the create-or-adopt path makes, against the
	// labels this POST stamps. All GETs; a refusal leaves nothing behind.
	const subject = `to allocate workspace ${workspaceId} as Sandbox ${name} in namespace ${config.namespace}`
	if (config.egress) await plan.boundary?.verifyNamedObject(signal)
	const verifyIngress = buildIngressVerifier(plan.client, config)
	if (verifyIngress !== undefined) await verifyIngress(plan.workspacePodLabels, subject, signal)
	// Without the per-sandbox label, for the reason `createKubernetesWorkspace`
	// gives: the only policy selecting by it is this workspace's own.
	await plan.boundary?.verifyUnion(
		withoutPerSandboxLabel(plan.workspacePodLabels, perSandboxWorkspaceLabels(config.egress, name)),
		subject,
		signal,
	)

	const stored: Required<KubernetesWorkspaceAllocation> = {
		id: options.allocation.id,
		scopeFingerprint: options.allocation.scopeFingerprint,
		executionProfile: fingerprint,
	}
	const body = buildSandboxBody({
		namespace: config.namespace,
		name,
		template: plan.template,
		sandboxTemplateName: plan.templateName,
		podLabels: plan.podLabels,
		annotations: {
			...(epoch !== undefined ? { [HOLDER_EPOCH_ANNOTATION_KEY]: String(epoch) } : {}),
			[POD_TEMPLATE_HASH_ANNOTATION_KEY]: plan.profile.podTemplateHash,
			[ALLOCATION_ID_ANNOTATION_KEY]: stored.id,
			[ALLOCATION_SCOPE_ANNOTATION_KEY]: stored.scopeFingerprint,
			[EXECUTION_PROFILE_ANNOTATION_KEY]: stored.executionProfile,
		},
		...(config.runtimeClassName !== undefined ? { runtimeClassName: config.runtimeClassName } : {}),
	})
	const unknown = (
		reason: KubernetesAllocationUnknownReason,
		error: unknown,
	): KubernetesWorkspaceAllocationResult => ({
		outcome: 'unknown',
		reason,
		workspaceId,
		sandboxName: name,
		allocation: stored,
		...(epoch !== undefined ? { epoch } : {}),
		error,
	})

	let created: SandboxResource | undefined
	try {
		// The one and only create. `client.request` does not retry.
		created = await plan.client.request<SandboxResource>(
			'POST',
			sandboxCollectionPath(config.namespace),
			body,
			signal,
		)
	} catch (err) {
		if (err instanceof KubernetesConflictError) {
			throw new KubernetesWorkspaceAllocationConflictError(workspaceId, name)
		}
		const reason = unknownReason(err, signal)
		if (reason === undefined) throw err
		return unknown(reason, err)
	}
	const sandboxUid = created?.metadata?.uid
	if (typeof sandboxUid !== 'string' || sandboxUid === '') {
		return unknown('unreadable-reply', new Error('the create reply carried no metadata.uid'))
	}
	return {
		outcome: 'created',
		receipt: {
			workspaceId,
			sandboxName: name,
			namespace: config.namespace,
			sandboxUid,
			allocation: stored,
			...(epoch !== undefined ? { epoch } : {}),
			templateRevision: plan.profile.podTemplateHash,
		},
	}
}

/** {@link recoverKubernetesWorkspaceAllocation}'s options. */
export interface KubernetesWorkspaceAllocationRecoverOptions {
	readonly workspaceId: string
	/** The allocation that was sent; `executionProfile` is compared when present. */
	readonly allocation: KubernetesWorkspaceAllocation
	/** When given, a workspace held at a higher epoch refuses the read. */
	readonly epoch?: number
	readonly signal?: AbortSignal
}

/**
 * What a read-only look found after an unknown create.
 *
 *  - `created` — a Sandbox stands there carrying exactly the allocation;
 *    `receipt` is the one the lost reply would have been.
 *  - `absent` — no Sandbox stands there at the moment of the read. A create
 *    still in flight at the API server could land afterwards, so this is a
 *    point-in-time answer: allocate again with the SAME allocation is safe
 *    (a late landing makes it a typed conflict, and recovery then says
 *    `created`), a different allocation under this id is not.
 *  - `different` — something else stands there; `mismatch` says what differs.
 */
export type KubernetesWorkspaceAllocationRecovery =
	| { readonly state: 'created'; readonly receipt: KubernetesWorkspaceAllocationReceipt }
	| { readonly state: 'absent'; readonly workspaceId: string; readonly sandboxName: string }
	| {
			readonly state: 'different'
			readonly workspaceId: string
			readonly sandboxName: string
			readonly mismatch: KubernetesWorkspaceAllocationMismatch
			readonly observed: KubernetesObservedAllocation
			readonly sandboxUid: string | undefined
	  }

/**
 * Settle an unknown create by reading: one GET of the Sandbox, compared with
 * the expected allocation. Never creates, wakes or writes. A read that did
 * not answer rejects as itself — it is never reported as `absent`.
 */
export async function recoverKubernetesWorkspaceAllocation(
	config: KubernetesBackendInternalConfig,
	options: KubernetesWorkspaceAllocationRecoverOptions,
): Promise<KubernetesWorkspaceAllocationRecovery> {
	options.signal?.throwIfAborted()
	const { workspaceId } = options
	assertAllocation(options.allocation, 'recoverKubernetesWorkspaceAllocation')
	const epoch = assertHolderEpoch(options.epoch, 'recoverKubernetesWorkspaceAllocation')
	const name = workspaceSandboxName(workspaceId)
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	let sandbox: SandboxResource | undefined
	try {
		sandbox = await client.request<SandboxResource>(
			'GET',
			sandboxPath(config.namespace, name),
			undefined,
			options.signal,
		)
	} catch (err) {
		if (!(err instanceof KubernetesAlreadyGoneError)) throw err
	}
	if (sandbox === undefined) return { state: 'absent', workspaceId, sandboxName: name }
	if (epoch !== undefined) {
		const held = readHolderEpoch(sandbox.metadata)
		if (held.epoch === undefined || held.epoch > epoch) {
			throw new KubernetesWorkspacePreconditionError(
				'recoverKubernetesWorkspaceAllocation',
				workspaceId,
				name,
				epoch,
				held.epoch,
				held.annotation,
			)
		}
	}
	const mismatch = firstAllocationMismatch(sandbox, options.allocation)
	const sandboxUid = sandbox.metadata?.uid
	if (mismatch !== undefined || typeof sandboxUid !== 'string' || sandboxUid === '') {
		return {
			state: 'different',
			workspaceId,
			sandboxName: name,
			mismatch: mismatch?.kind ?? 'allocation-id',
			observed: observedAllocation(sandbox),
			sandboxUid,
		}
	}
	const observed = observedAllocation(sandbox)
	return {
		state: 'created',
		receipt: {
			workspaceId,
			sandboxName: name,
			namespace: config.namespace,
			sandboxUid,
			allocation: {
				id: options.allocation.id,
				scopeFingerprint: options.allocation.scopeFingerprint,
				...(observed.executionProfile !== undefined
					? { executionProfile: observed.executionProfile }
					: {}),
			},
			...(epoch !== undefined ? { epoch } : {}),
			// Present: the template-content check above refuses an object without it.
			templateRevision: sandbox.metadata?.annotations?.[POD_TEMPLATE_HASH_ANNOTATION_KEY] ?? '',
		},
	}
}
