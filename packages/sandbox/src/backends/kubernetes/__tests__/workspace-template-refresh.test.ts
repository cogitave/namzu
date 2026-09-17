/**
 * Waking a workspace onto the SandboxTemplate as it stands now, keeping its
 * disk.
 *
 * A Sandbox's `spec.podTemplate` is a copy of the template's, taken once in
 * the create POST, and agent-sandbox builds every replacement pod from that
 * copy rather than from the template. So a workspace kept for weeks runs the
 * pod spec it was created with: a new image tag, a memory limit, a
 * `terminationGracePeriodSeconds` or an env entry reaches only workspaces
 * created after the edit, and the release that changes the agent's protocol
 * strands every one of them — every adopt and every resume fails its
 * privilege probe, and `destroy({ deleteDisk: true })` is the only way out.
 *
 * `refreshPodTemplate` is the opt-in that writes the current template onto a
 * workspace as it wakes. Four properties carry the design, and each has its
 * own cases below:
 *
 *  - **one conditional patch.** `test /spec/operatingMode == "Suspended"` is
 *    what enforces "only on a suspended workspace", not the read before it,
 *    and when a holder epoch is configured its clause rides in the SAME body.
 *  - **JSON Patch, not a merge patch.** A merge patch recurses into maps, so
 *    a `nodeSelector` entry the template dropped would survive on the object.
 *  - **never on a Running Sandbox.** The controller does not rewrite a pod
 *    that already exists, so a Running object patched this way would carry a
 *    spec describing a pod it is not running. Both ways of arriving at one —
 *    an adopt that finds it Running, and a `test` that loses to another
 *    process's resume — bind the pod that is there, unchanged.
 *  - **the default is untouched.** Without the option, `resume()` sends the
 *    same single merge patch it always sent and an adopt behaves identically.
 *
 * The fake API server applies real RFC 6902 semantics — `test` compares, and
 * a failed one answers the opaque 422 a real API server answers with, which
 * is indistinguishable from a malformed body and is why the host re-reads the
 * object to tell a lost race from a wrong patch.
 *
 * What this file CANNOT prove, and does not claim: that the sandbox
 * controller builds the replacement pod from `spec.podTemplate` as rewritten.
 * That is upstream behaviour, and what is asserted here is the object this
 * backend leaves on the cluster for it to read. Settling it needs neither a
 * disk nor a workspace, so the local cluster's lack of block storage is not
 * what is in the way: a bare Sandbox with any pod template and no
 * volumeClaimTemplates, suspended, then JSON-patched with a changed image tag,
 * a changed terminationGracePeriodSeconds, one nodeSelector key dropped and
 * `operatingMode: Running`, and the replacement pod's own spec read back. That
 * run was ATTEMPTED and could not be made: the environment this was written in
 * refuses cluster writes. Until it is made the premise is taken from the
 * upstream source the issue quotes. The `test` clause bounds the cost of the
 * premise being wrong: a refresh that does not reach the pod is a missed
 * refresh, never a wrong write. `templateCurrent` would then report a
 * workspace as current while its pod ran the old spec, which is the failure to
 * watch for.
 *
 * The second unproven claim is the disk-preserving round trip through a real
 * BLOCK-mode PVC (the file's sha256 matches and the PVC uid is unchanged
 * across a refresh); that one genuinely needs a cluster with block storage.
 * What is proven here is that `spec.volumeClaimTemplates` never appears in the
 * patch and that the stored claims are byte-identical afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type KubernetesBackendConfig,
	KubernetesWorkspaceDiskError,
	KubernetesWorkspaceMismatchError,
	KubernetesWorkspacePreconditionError,
	createKubernetesWorkspace,
} from '../../../index.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'long-lived'
const WORKSPACE_NAME = 'namzu-ws-long-lived'
const TEMPLATE_NAME = 'namzu-workspace'
const OTHER_TEMPLATE_NAME = 'namzu-other'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=lgl'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const RETIRED_TOKEN = '99999999-9999-4999-8999-999999999999'
/**
 * Written out rather than imported, exactly as the neighbouring suites write
 * their annotation keys out: these are names that go onto a cluster object
 * and are read back by a later release, so a rename has to break a test
 * rather than follow a constant silently.
 */
const HASH_KEY = 'sandbox.namzu.ai/pod-template-hash'
const HASH_POINTER = '/metadata/annotations/sandbox.namzu.ai~1pod-template-hash'
const EPOCH_KEY = 'sandbox.namzu.ai/holder-epoch'
const EPOCH_POINTER = '/metadata/annotations/sandbox.namzu.ai~1holder-epoch'
const MODE_CHANGED_AT = 'sandbox.namzu.ai/operating-mode-changed-at'
const MODE_CHANGED_POINTER = '/metadata/annotations/sandbox.namzu.ai~1operating-mode-changed-at'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
/**
 * The egress profile the suite at the end of this file opts into. Written out
 * rather than imported, like the annotation keys above: it is a label key that
 * goes onto a cluster object and into a policy selector, so a rename has to
 * break a test.
 */
const PROFILE_KEY = 'sandbox.users.io/egress-profile'
const PROFILE = 'none'
const CREATED_AT = '2026-08-01T09:00:00Z'
const MERGE_PATCH = 'application/merge-patch+json'
const JSON_PATCH = 'application/json-patch+json'
/** `sha256:` plus 64 hex, which is the whole shape of the annotation. */
const HASH_SHAPE = /^sha256:[0-9a-f]{64}$/

type Json = Record<string, unknown>

/** The name of the disk the workspace is created with, and keeps. */
const DISK_NAME = 'workspace'

/** The disk a template declares, by name. */
function volumeClaimTemplates(diskName: string = DISK_NAME): Json[] {
	return [
		{
			metadata: { name: diskName },
			spec: { accessModes: ['ReadWriteOnce'], volumeMode: 'Block' },
		},
	]
}

interface TemplateShape {
	readonly image?: string
	readonly graceSeconds?: number
	readonly nodeSelector?: Record<string, string>
	readonly runtimeClassName?: string
	/**
	 * Rename the disk. A template like this is internally consistent — it
	 * declares a Block volume and claims it through `volumeDevices`, so it
	 * passes every check made against ITSELF — and still cannot carry the
	 * workspace, whose own `volumeClaimTemplates` are CEL-immutable and still
	 * name the old disk. That is the case the refresh's own check exists for,
	 * and the only one that isolates it from the create-path check.
	 */
	readonly diskName?: string
	/**
	 * Add a SECOND disk, the ordinary way: another `volumeClaimTemplates`
	 * entry and the matching `volumeDevices` entry. This template is
	 * internally consistent AND still claims the workspace's original disk, so
	 * it passes every check made against itself and every branch of the
	 * block-disk check — and a standing workspace still cannot have it, since
	 * `spec.volumeClaimTemplates` is CEL-immutable and no refresh writes it.
	 */
	readonly extraDiskName?: string
}

/** A SandboxTemplate, as the API server serves one. */
function buildTemplate(shape: TemplateShape = {}): Json {
	const diskName = shape.diskName ?? DISK_NAME
	const container: Json = {
		name: 'main',
		image: shape.image ?? 'namzu/agent:1',
		volumeDevices: [
			{ name: diskName, devicePath: '/dev/workspace' },
			...(shape.extraDiskName !== undefined
				? [{ name: shape.extraDiskName, devicePath: '/dev/cache' }]
				: []),
		],
	}
	return {
		metadata: { name: TEMPLATE_NAME, namespace: NAMESPACE },
		spec: {
			service: true,
			volumeClaimTemplates: [
				...volumeClaimTemplates(diskName),
				...(shape.extraDiskName !== undefined ? volumeClaimTemplates(shape.extraDiskName) : []),
			],
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				spec: {
					terminationGracePeriodSeconds: shape.graceSeconds ?? 5,
					...(shape.nodeSelector !== undefined ? { nodeSelector: shape.nodeSelector } : {}),
					...(shape.runtimeClassName !== undefined
						? { runtimeClassName: shape.runtimeClassName }
						: {}),
					containers: [container],
				},
			},
		},
	}
}

/**
 * The `spec.podTemplate` this backend would write for a given template: the
 * template's, plus the label overlay and the configured RuntimeClass. Spelled
 * out here rather than imported, so a change to the overlay rules has to be
 * restated in a test rather than followed silently.
 */
function expectedPodTemplate(template: Json, runtimeClassName?: string): Json {
	const podTemplate = (template.spec as Json).podTemplate as Json
	const spec = podTemplate.spec as Json
	return {
		metadata: { labels: expectedPodLabels() },
		spec: { ...spec, ...(runtimeClassName !== undefined ? { runtimeClassName } : {}) },
	}
}

/**
 * The labels that overlay names: the template label always, and the egress
 * profile whenever this test has configured one.
 *
 * A refresh replaces `/spec/podTemplate` WHOLE, so these travel in the patch
 * or they are removed from the object by it — which is the failure the profile
 * suite at the end of this file exists to catch.
 */
function expectedPodLabels(): Record<string, string> {
	return {
		[TEMPLATE_LABEL]: TEMPLATE_NAME,
		...(profiledEgress !== undefined ? { [PROFILE_KEY]: PROFILE } : {}),
	}
}

/** The `deny-all` policy the profile suite's cluster serves, selector and all. */
function egressPolicyObject(): Json {
	return {
		metadata: { name: `${TEMPLATE_NAME}-${PROFILE}-egress`, namespace: NAMESPACE },
		spec: {
			podSelector: { matchLabels: expectedPodLabels() },
			policyTypes: ['Egress'],
			egress: [
				{
					to: [
						{
							namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
						},
					],
					ports: [
						{ protocol: 'UDP', port: 53 },
						{ protocol: 'TCP', port: 53 },
					],
				},
			],
		},
	}
}

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

/** The template the API server currently serves; a test edits it in place. */
let template: Json
let sandboxes: Map<string, Json>
let livePodUid: string | undefined
let drainingGets: number
let drainingUid: string
let nextPodUid: string
let resourceVersionSeq: number
/**
 * Resume the object the instant before the next JSON patch is evaluated —
 * another host process winning the race the `test` clause exists to lose.
 */
let resumeBeforeNextJsonPatch: boolean
/**
 * Stamp these annotations on the object the instant before the next JSON
 * patch is evaluated, WITHOUT moving `spec.operatingMode` — another writer
 * touching only `metadata`, which no clause about `spec` can notice.
 */
let annotateBeforeNextJsonPatch: Record<string, string> | undefined
/**
 * Refuse the next JSON patch AND delete the object — the narrowest window
 * this path has: the `test` loses, and whoever won deletes the workspace
 * before the loser can re-read it to find out what refused the patch.
 */
let vanishBetweenPatchAndReread: boolean
/** Pod reads that answer "nothing yet" before the replacement shows up. */
let podAppearsAfterReads: number
/**
 * The egress configuration under test, or `undefined` — which is every case
 * but the profile suite at the end, and is what keeps their request logs free
 * of policy reads.
 */
let profiledEgress: KubernetesBackendConfig['egress'] | undefined

beforeEach(async () => {
	template = buildTemplate()
	sandboxes = new Map()
	livePodUid = FIRST_POD_UID
	drainingGets = 0
	drainingUid = FIRST_POD_UID
	nextPodUid = SECOND_POD_UID
	resourceVersionSeq = 1000
	resumeBeforeNextJsonPatch = false
	annotateBeforeNextJsonPatch = undefined
	vanishBetweenPatchAndReread = false
	podAppearsAfterReads = 0
	profiledEgress = undefined
	agent = await startScriptedAgent({ token: FIRST_POD_UID })
	restoreDns = stubLoopbackDns()
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function nextResourceVersion(): string {
	resourceVersionSeq += 1
	return String(resourceVersionSeq)
}

function metaOf(object: Json): Json {
	return object.metadata as Json
}

function specOf(object: Json): Json {
	return object.spec as Json
}

function annotationsOf(object: Json): Record<string, string> | undefined {
	return metaOf(object).annotations as Record<string, string> | undefined
}

function modeOf(object: Json): string {
	return specOf(object).operatingMode as string
}

function stored(): Json {
	const object = sandboxes.get(WORKSPACE_NAME)
	if (!object) throw new Error('no Sandbox under that name')
	return object
}

function storedPodTemplate(): Json {
	return specOf(stored()).podTemplate as Json
}

function storedHash(): string | undefined {
	return annotationsOf(stored())?.[HASH_KEY]
}

/**
 * Put a Sandbox in the namespace WITHOUT going through a create, which is how
 * a test describes an object another process left behind.
 */
function seedWorkspace(options: {
	mode?: 'Running' | 'Suspended'
	podTemplate?: Json
	annotations?: Record<string, string>
	/**
	 * The disks the object was created with. Defaults to the single default
	 * disk, which is what a workspace another process left behind has; the
	 * create handler passes what the POST body actually declared, because
	 * `spec.volumeClaimTemplates` is frozen at exactly that and every later
	 * refusal is measured against it.
	 */
	volumeClaimTemplates?: Json[]
}): void {
	const object: Json = {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: {
			name: WORKSPACE_NAME,
			namespace: NAMESPACE,
			creationTimestamp: CREATED_AT,
			resourceVersion: nextResourceVersion(),
			...(options.annotations !== undefined ? { annotations: options.annotations } : {}),
		},
		spec: {
			operatingMode: options.mode ?? 'Running',
			service: true,
			volumeClaimTemplates: options.volumeClaimTemplates ?? volumeClaimTemplates(),
			podTemplate: options.podTemplate ?? expectedPodTemplate(template),
		},
		status: {
			conditions: [readyCondition('True')],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
	if (options.mode === 'Suspended') livePodUid = undefined
	sandboxes.set(WORKSPACE_NAME, object)
}

// --- RFC 6902, as much of it as this backend sends -------------------------

interface PatchOperation {
	readonly op: string
	readonly path: string
	readonly value: unknown
}

/** RFC 6901 §3, backwards: `~1` is `/` and `~0` is `~`, in that order. */
function unescapeToken(token: string): string {
	return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function pointerTokens(pointer: string): string[] {
	return pointer.split('/').slice(1).map(unescapeToken)
}

function resolvePointer(root: Json, pointer: string): unknown {
	let cursor: unknown = root
	for (const token of pointerTokens(pointer)) {
		if (typeof cursor !== 'object' || cursor === null) return undefined
		cursor = (cursor as Record<string, unknown>)[token]
	}
	return cursor
}

/**
 * Apply one operation list, ALL OR NOTHING — a patch the API server refuses
 * leaves the object exactly as it was, which is what "a refused refresh
 * changes nothing on the cluster" means and would be untestable against a
 * fake that mutated as it went.
 */
function applyJsonPatch(object: Json, operations: readonly PatchOperation[]): boolean {
	const draft = JSON.parse(JSON.stringify(object)) as Json
	for (const operation of operations) {
		if (operation.op === 'test') {
			if (JSON.stringify(resolvePointer(draft, operation.path)) !== JSON.stringify(operation.value))
				return false
			continue
		}
		if (operation.op !== 'add') return false
		const tokens = pointerTokens(operation.path)
		const last = tokens.pop()
		if (last === undefined) return false
		let cursor: unknown = draft
		for (const token of tokens) {
			if (typeof cursor !== 'object' || cursor === null) return false
			cursor = (cursor as Record<string, unknown>)[token]
		}
		if (typeof cursor !== 'object' || cursor === null) return false
		;(cursor as Record<string, unknown>)[last] = operation.value
	}
	metaOf(draft).resourceVersion = nextResourceVersion()
	Object.assign(object, draft)
	return true
}

/** RFC 7386, recursing into `metadata.annotations` exactly as one does. */
function applyMergePatch(object: Json, patch: Json): void {
	const patchMeta = (patch.metadata ?? {}) as { annotations?: Record<string, string> }
	if (patchMeta.annotations !== undefined) {
		metaOf(object).annotations = { ...annotationsOf(object), ...patchMeta.annotations }
	}
	const patchSpec = (patch.spec ?? {}) as { operatingMode?: string }
	if (patchSpec.operatingMode !== undefined) {
		specOf(object).operatingMode = patchSpec.operatingMode
	}
	metaOf(object).resourceVersion = nextResourceVersion()
}

/**
 * The body a real API server answers an unapplied JSON patch with — measured
 * against v1.37.0 and the `Sandbox` CRD. A failed `test` and a malformed body
 * answer identically, which is exactly why the host has to re-read the object
 * to tell them apart.
 */
const PATCH_NOT_APPLIED: FakeApiReply = {
	status: 422,
	body: {
		kind: 'Status',
		apiVersion: 'v1',
		metadata: {},
		status: 'Failure',
		message: 'the server rejected our request due to an error in our request',
		reason: 'Invalid',
		details: {},
		code: 422,
	},
}

function livePod(uid: string): Json {
	return { metadata: { name: WORKSPACE_NAME, uid }, status: { phase: 'Running' } }
}

function terminatingPod(uid: string): Json {
	return {
		metadata: { name: WORKSPACE_NAME, uid, deletionTimestamp: '2026-09-16T00:00:01Z' },
		status: { phase: 'Running' },
	}
}

function objectName(path: string): string {
	const withoutQuery = path.split('?')[0] ?? ''
	return decodeURIComponent(withoutQuery.split('/').pop() ?? '')
}

/** The pod side of a mode change, shared by both patch dialects. */
function reconcileMode(previous: string, next: string): void {
	if (previous === next) return
	if (next === 'Suspended') {
		drainingUid = livePodUid ?? drainingUid
		drainingGets = 1
		livePodUid = undefined
		agent?.setToken(RETIRED_TOKEN)
	} else {
		drainingGets = 0
		livePodUid = nextPodUid
		agent?.setToken(nextPodUid)
	}
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: template }
	}
	// Only ever reached by the profile suite: no other case configures egress,
	// so no other case asks.
	if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
		return { status: 200, body: egressPolicyObject() }
	}
	if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
		return { status: 200, body: { items: [egressPolicyObject()] } }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		if (sandboxes.has(WORKSPACE_NAME)) {
			return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
		}
		const body = req.body as Json
		const bodyMeta = (body.metadata ?? {}) as { annotations?: Record<string, string> }
		const bodySpec = (body.spec ?? {}) as {
			podTemplate?: Json
			volumeClaimTemplates?: Json[]
		}
		seedWorkspace({
			mode: 'Running',
			...(bodySpec.podTemplate !== undefined ? { podTemplate: bodySpec.podTemplate } : {}),
			...(bodyMeta.annotations !== undefined ? { annotations: bodyMeta.annotations } : {}),
			// Stored as sent, and never writable again: this is the field the
			// CRD makes CEL-immutable, so the object's disks are whatever the
			// create POST froze.
			...(bodySpec.volumeClaimTemplates !== undefined
				? { volumeClaimTemplates: bodySpec.volumeClaimTemplates }
				: {}),
		})
		livePodUid = FIRST_POD_UID
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const object = sandboxes.get(objectName(req.path))
		if (!object) return { status: 404, body: { message: 'gone' } }
		if (vanishBetweenPatchAndReread && req.contentType === JSON_PATCH) {
			// The patch is refused with the opaque 422, and the object is gone
			// by the time the host re-reads it to find out why.
			vanishBetweenPatchAndReread = false
			sandboxes.delete(objectName(req.path))
			livePodUid = undefined
			return PATCH_NOT_APPLIED
		}
		if (resumeBeforeNextJsonPatch && req.contentType === JSON_PATCH) {
			resumeBeforeNextJsonPatch = false
			const before = modeOf(object)
			specOf(object).operatingMode = 'Running'
			metaOf(object).resourceVersion = nextResourceVersion()
			reconcileMode(before, 'Running')
		}
		if (annotateBeforeNextJsonPatch !== undefined && req.contentType === JSON_PATCH) {
			// Another writer stamps an annotation and leaves `spec` alone —
			// which is exactly what a suspend carrying a holder epoch does to an
			// already-Suspended object. The mode clause cannot see it.
			metaOf(object).annotations = {
				...annotationsOf(object),
				...annotateBeforeNextJsonPatch,
			}
			metaOf(object).resourceVersion = nextResourceVersion()
			annotateBeforeNextJsonPatch = undefined
		}
		const before = modeOf(object)
		if (req.contentType === JSON_PATCH) {
			if (!applyJsonPatch(object, req.body as readonly PatchOperation[])) return PATCH_NOT_APPLIED
		} else {
			applyMergePatch(object, req.body as Json)
		}
		reconcileMode(before, modeOf(object))
		return { status: 200, body: object }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		const object = sandboxes.get(objectName(req.path))
		if (!object) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: object }
	}
	if (req.method === 'DELETE' && req.path.includes('/sandboxes/')) {
		sandboxes.delete(objectName(req.path))
		livePodUid = undefined
		return { status: 200, body: { kind: 'Status' } }
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (drainingGets > 0) return { status: 200, body: { items: [terminatingPod(drainingUid)] } }
		if (podAppearsAfterReads > 0) {
			podAppearsAfterReads -= 1
			return { status: 200, body: { items: [] } }
		}
		return { status: 200, body: { items: livePodUid ? [livePod(livePodUid)] : [] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (drainingGets > 0) {
			drainingGets -= 1
			return { status: 200, body: terminatingPod(drainingUid) }
		}
		if (podAppearsAfterReads > 0) {
			podAppearsAfterReads -= 1
			return { status: 404, body: { message: 'gone' } }
		}
		if (livePodUid === undefined) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod(livePodUid) }
	}
	return { status: 404, body: { message: 'unexpected' } }
}

function clusterConfig(runtimeClassName?: string): KubernetesBackendConfig {
	if (!server || !agent) throw new Error('fixtures not started')
	return {
		tier: 'microvm',
		service: 'kubernetes',
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TEMPLATE_NAME,
		agentPort: agent.port,
		readyTimeoutMs: 1_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		...(profiledEgress !== undefined ? { egress: profiledEgress } : {}),
		...(runtimeClassName !== undefined ? { runtimeClassName } : {}),
	}
}

async function openWorkspace(
	options: { refreshPodTemplate?: boolean; epoch?: number; runtimeClassName?: string } = {},
) {
	return await createKubernetesWorkspace(clusterConfig(options.runtimeClassName), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: '/workspace',
		...(options.refreshPodTemplate === true ? { refreshPodTemplate: true } : {}),
		...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
	})
}

function requestsBy(method: string): readonly RecordedRequest[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests.filter((r) => r.method === method)
}

function sandboxPatches(): readonly RecordedRequest[] {
	return requestsBy('PATCH').filter((r) => r.path.includes('/sandboxes/'))
}

function patchOperations(request: RecordedRequest): readonly PatchOperation[] {
	return request.body as readonly PatchOperation[]
}

describe('a resume that asks for no refresh', () => {
	it('sends the single merge patch it always sent, and leaves the stored template alone', async () => {
		// The acceptance criterion the whole feature is adoptable on: the
		// default path is byte for byte what it was, even when the template
		// underneath has moved on.
		const held = await openWorkspace()
		const created = JSON.parse(JSON.stringify(storedPodTemplate())) as Json
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2', graceSeconds: 90 })
		await held.resume()

		const patches = sandboxPatches()
		expect(patches.map((p) => p.contentType)).toEqual([MERGE_PATCH, MERGE_PATCH])
		expect(patches[1]?.body).toEqual({
			metadata: { annotations: { [MODE_CHANGED_AT]: expect.any(String) } },
			spec: { operatingMode: 'Running' },
		})
		// The object still describes the pod it was created with, which is the
		// defect this feature exists to give an opt-out from — not a claim
		// that it is desirable.
		expect(storedPodTemplate()).toEqual(created)
		expect((storedPodTemplate().spec as Json).terminationGracePeriodSeconds).toBe(5)
		await held.destroy()
	}, 30_000)

	it('records what the create was built from, so a later refresh has something to compare', async () => {
		const held = await openWorkspace()
		expect(storedHash()).toMatch(HASH_SHAPE)
		expect(held.templateRevision).toBe(storedHash())
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 20_000)
})

describe('a refresh through a handle', () => {
	it('sends one JSON Patch carrying the mode test, the new template and its revision', async () => {
		const held = await openWorkspace()
		const before = held.templateRevision
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2', graceSeconds: 90 })
		const patchesBefore = sandboxPatches().length

		await held.resume({ refreshPodTemplate: true })

		const patches = sandboxPatches()
		expect(patches).toHaveLength(patchesBefore + 1)
		const refresh = patches.at(-1) as RecordedRequest
		expect(refresh.contentType).toBe(JSON_PATCH)
		expect(patchOperations(refresh)).toEqual([
			{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
			{ op: 'add', path: MODE_CHANGED_POINTER, value: expect.any(String) },
			{ op: 'add', path: HASH_POINTER, value: expect.stringMatching(HASH_SHAPE) },
			{ op: 'add', path: '/spec/podTemplate', value: expectedPodTemplate(template) },
			{ op: 'add', path: '/spec/operatingMode', value: 'Running' },
		])

		// And the object now describes the pod the controller will build.
		expect(storedPodTemplate()).toEqual(expectedPodTemplate(template))
		expect(((storedPodTemplate().spec as Json).containers as Json[])[0]?.image).toBe(
			'namzu/agent:2',
		)
		expect((storedPodTemplate().spec as Json).terminationGracePeriodSeconds).toBe(90)
		expect(storedHash()).not.toBe(before)
		expect(held.templateRevision).toBe(storedHash())
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 30_000)

	it('drops a key the template removed, which a merge patch would have kept', async () => {
		template = buildTemplate({ nodeSelector: { 'kubernetes.io/arch': 'amd64', pool: 'blue' } })
		const held = await openWorkspace()
		expect((storedPodTemplate().spec as Json).nodeSelector).toEqual({
			'kubernetes.io/arch': 'amd64',
			pool: 'blue',
		})
		await held.suspend()
		template = buildTemplate({ nodeSelector: { 'kubernetes.io/arch': 'amd64' } })

		await held.resume({ refreshPodTemplate: true })

		expect((storedPodTemplate().spec as Json).nodeSelector).toEqual({
			'kubernetes.io/arch': 'amd64',
		})
		await held.destroy()
	}, 30_000)

	it('leaves the disk alone: volumeClaimTemplates is not in the patch', async () => {
		const held = await openWorkspace()
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2' })

		await held.resume({ refreshPodTemplate: true })

		const refresh = sandboxPatches().at(-1) as RecordedRequest
		expect(patchOperations(refresh).map((op) => op.path)).not.toContain(
			'/spec/volumeClaimTemplates',
		)
		expect(specOf(stored()).volumeClaimTemplates).toEqual(volumeClaimTemplates())
		await held.destroy()
	}, 30_000)
})

describe('a refresh through adopt', () => {
	it('wakes a suspended workspace another process left behind onto the current template', async () => {
		// The entry point a restarted host has: no handle, the workspace found
		// again by name. The workspace is created and suspended by one
		// "process", the template is edited, and a second create adopts it.
		const first = await openWorkspace()
		await first.suspend()
		template = buildTemplate({ image: 'namzu/agent:2', graceSeconds: 90 })
		const patchesBefore = sandboxPatches().length

		const second = await openWorkspace({ refreshPodTemplate: true })

		expect(second.origin).toBe('resumed')
		const patches = sandboxPatches()
		expect(patches).toHaveLength(patchesBefore + 1)
		expect(patches.at(-1)?.contentType).toBe(JSON_PATCH)
		// The object the controller builds the replacement pod from carries
		// the template as it stands NOW.
		expect(storedPodTemplate()).toEqual(expectedPodTemplate(template))
		expect(modeOf(stored())).toBe('Running')
		expect(second.templateRevision).toBe(storedHash())
		expect(second.templateCurrent).toBe(true)
		// And the handle is bound to the replacement pod, not the retired one.
		expect(livePodUid).toBe(SECOND_POD_UID)
		expect((await second.exec('true')).exitCode).toBe(0)
		await second.destroy()
	}, 40_000)

	it('binds a RUNNING workspace unchanged and reports it as off-template', async () => {
		// v1.0.2 does not rewrite a pod that already exists, so patching a
		// Running Sandbox would leave its spec describing a pod it is not
		// running. `templateCurrent: false` is how a host learns it should
		// schedule a suspend and a resume.
		const first = await openWorkspace()
		const createdTemplate = JSON.parse(JSON.stringify(storedPodTemplate())) as Json
		template = buildTemplate({ image: 'namzu/agent:2' })
		const patchesBefore = sandboxPatches().length

		const second = await openWorkspace({ refreshPodTemplate: true })

		expect(second.origin).toBe('adopted-running')
		expect(sandboxPatches()).toHaveLength(patchesBefore)
		expect(storedPodTemplate()).toEqual(createdTemplate)
		expect(second.templateCurrent).toBe(false)
		expect(second.templateRevision).toBe(storedHash())
		expect(livePodUid).toBe(FIRST_POD_UID)
		await first.destroy()
	}, 40_000)

	it('reports no revision at all for a workspace created before this release', async () => {
		// Nothing stamped a hash when the object was made, so there is nothing
		// to report: `templateRevision` is `undefined`, which reads as UNKNOWN
		// rather than as a revision that happens not to match. `templateCurrent`
		// is false either way — a revision nothing recorded cannot be asserted
		// to be the current one — and that is what makes a suspend-and-resume
		// the safe answer for an object like this.
		seedWorkspace({ mode: 'Running', podTemplate: expectedPodTemplate(template) })
		expect(annotationsOf(stored())).toBeUndefined()

		const held = await openWorkspace({ refreshPodTemplate: true })

		expect(held.origin).toBe('adopted-running')
		expect(held.templateRevision).toBeUndefined()
		expect(held.templateCurrent).toBe(false)
		// And nothing was stamped on the way past: a hash is written by a
		// create or by a refresh that lands, never by an adopt of a Running
		// object, whose pod is not the one the hash would describe.
		expect(storedHash()).toBeUndefined()
		await held.destroy()
	}, 30_000)

	it('still refuses a RUNNING workspace on the wrong RuntimeClass', async () => {
		// The refusal is lifted only for a call whose patch WRITES the
		// configured class. No patch lands on a Running object, so a pod on
		// the wrong runtime is never bound.
		seedWorkspace({
			mode: 'Running',
			podTemplate: expectedPodTemplate(template, 'runc'),
			annotations: { [HASH_KEY]: 'sha256:stale' },
		})
		const refusal = await openWorkspace({
			refreshPodTemplate: true,
			runtimeClassName: 'kata-qemu',
		}).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		expect((refusal as KubernetesWorkspaceMismatchError).field).toBe('runtimeClassName')
		expect(sandboxPatches()).toHaveLength(0)
	}, 20_000)

	it('writes the configured RuntimeClass onto a SUSPENDED workspace instead of refusing it', async () => {
		// The one refusal the option lifts, and only because the patch that
		// lands is what makes the object match.
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		template = buildTemplate({ runtimeClassName: 'ignored-by-the-overlay' })

		const held = await openWorkspace({ refreshPodTemplate: true, runtimeClassName: 'kata-qemu' })

		expect((storedPodTemplate().spec as Json).runtimeClassName).toBe('kata-qemu')
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 30_000)

	it('never moves a workspace to another template, option or not', async () => {
		// The label refusal is unconditional: a refresh rewrites a workspace's
		// pod spec, it never re-homes the workspace.
		seedWorkspace({
			mode: 'Suspended',
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: OTHER_TEMPLATE_NAME } },
				spec: expectedPodTemplate(template).spec as Json,
			},
		})
		const refusal = await openWorkspace({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		expect((refusal as KubernetesWorkspaceMismatchError).field).toBe('sandboxTemplateName')
		expect(sandboxPatches()).toHaveLength(0)
		expect(modeOf(stored())).toBe('Suspended')
	}, 20_000)
})

describe('a template that would lose the disk', () => {
	it('is refused before any patch, and the workspace stays Suspended', async () => {
		const held = await openWorkspace()
		await held.suspend()
		const patchesBefore = sandboxPatches().length
		// The template renames its disk. It is a perfectly good template — a
		// workspace created from it today would work — but the Sandbox's own
		// volumeClaimTemplates are CEL-immutable and still name the old disk,
		// so the refreshed pod would come up with that disk attached to
		// nothing and the only symptom would be that yesterday's files are
		// gone.
		template = buildTemplate({ diskName: 'workspace-v2' })

		const refusal = await held.resume({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceDiskError)
		expect(sandboxPatches()).toHaveLength(patchesBefore)
		expect(modeOf(stored())).toBe('Suspended')
		expect(held.suspended).toBe(true)
	}, 30_000)

	it('is refused on the adopt path too, waking nothing', async () => {
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		template = buildTemplate({ diskName: 'workspace-v2' })

		const refusal = await openWorkspace({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceDiskError)
		expect(sandboxPatches()).toHaveLength(0)
		expect(modeOf(stored())).toBe('Suspended')
		expect(livePodUid).toBeUndefined()
	}, 20_000)
})

describe('a template that would ADD a disk', () => {
	// The other direction, and the one only a refresh can get wrong. On the
	// create path the pod template and the volumeClaimTemplates come out of
	// the same read, so they cannot disagree; on a refresh the disks are
	// frozen (CEL-immutable, never in the patch) while the pod template
	// becomes whatever the template says now. A second disk is the ordinary
	// edit — the same edit as a new image tag, from the operator's side — and
	// the resulting template passes every check made against itself.
	it('is refused before any patch, and the workspace stays Suspended', async () => {
		const held = await openWorkspace()
		await held.suspend()
		const patchesBefore = sandboxPatches().length
		template = buildTemplate({ extraDiskName: 'cache' })

		const refusal = await held.resume({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceDiskError)
		// The message names the disk that cannot be had and why.
		expect((refusal as Error).message).toContain('"cache"')
		expect((refusal as Error).message).toContain('CEL-immutable')
		expect(sandboxPatches()).toHaveLength(patchesBefore)
		expect(modeOf(stored())).toBe('Suspended')
		expect(held.suspended).toBe(true)
		// And the object still describes a pod the controller can build.
		expect(
			((storedPodTemplate().spec as Json).containers as Json[])[0]?.volumeDevices,
		).toHaveLength(1)
	}, 30_000)

	it('is refused on the adopt path too, waking nothing', async () => {
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		template = buildTemplate({ extraDiskName: 'cache' })

		const refusal = await openWorkspace({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceDiskError)
		expect(sandboxPatches()).toHaveLength(0)
		expect(modeOf(stored())).toBe('Suspended')
		expect(livePodUid).toBeUndefined()
	}, 20_000)

	it('is not refused when the workspace was created with that disk all along', async () => {
		// The refusal is about the SANDBOX not having the disk, never about
		// the number of disks: a workspace created from a two-disk template
		// refreshes onto a two-disk template like any other.
		template = buildTemplate({ extraDiskName: 'cache' })
		const held = await openWorkspace()
		await held.suspend()
		template = buildTemplate({ extraDiskName: 'cache', image: 'namzu/agent:2' })

		await held.resume({ refreshPodTemplate: true })

		expect(((storedPodTemplate().spec as Json).containers as Json[])[0]?.image).toBe(
			'namzu/agent:2',
		)
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 30_000)
})

describe('losing the mode test to another process', () => {
	it('binds the pod that is there, rewrites nothing, and does not retry', async () => {
		const held = await openWorkspace()
		const createdTemplate = JSON.parse(JSON.stringify(storedPodTemplate())) as Json
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2' })
		const patchesBefore = sandboxPatches().length
		// Another host process resumes it in the window between this call's
		// read and its patch. The `test` is what notices, and the 422 that
		// comes back is indistinguishable from a malformed body.
		resumeBeforeNextJsonPatch = true

		await held.resume({ refreshPodTemplate: true })

		// Exactly one attempt: a mode clause that is no longer true is an
		// outcome, not something to re-send.
		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		expect(storedPodTemplate()).toEqual(createdTemplate)
		expect(modeOf(stored())).toBe('Running')
		expect(held.templateCurrent).toBe(false)
		expect(held.suspended).toBe(false)
		expect((await held.exec('true')).exitCode).toBe(0)
		await held.destroy()
	}, 40_000)

	it('waits for the winner\u2019s pod instead of failing on a read that finds none', async () => {
		// The adopt observed the object Suspended, so a replacement pod is on
		// its way in whether this call authored the transition or not. Losing
		// the race must not also cost the bind: the controller has been asked
		// for a pod by SOMEBODY, and the first read that finds none is "not
		// yet" rather than fatal.
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		template = buildTemplate({ image: 'namzu/agent:2' })
		resumeBeforeNextJsonPatch = true
		// The winner's pod is not up for the first few reads.
		podAppearsAfterReads = 4

		const held = await openWorkspace({ refreshPodTemplate: true })

		expect(held.origin).toBe('adopted-running')
		expect(held.templateCurrent).toBe(false)
		expect((await held.exec('true')).exitCode).toBe(0)
		await held.destroy()
	}, 40_000)
})

describe('a refresh onto an object that carries no annotations at all', () => {
	// Only a workspace created before this release: every create from now on
	// stamps at least the pod-template revision. There is no annotations map
	// to add a key to, so the map goes up WHOLE — the one mutation this
	// backend builds that can erase another writer's work.
	it('conditions the whole-map write on resourceVersion', async () => {
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		expect(annotationsOf(stored())).toBeUndefined()
		const version = metaOf(stored()).resourceVersion as string

		const held = await openWorkspace({ refreshPodTemplate: true })

		const refresh = sandboxPatches().at(-1) as RecordedRequest
		const operations = patchOperations(refresh)
		expect(operations.filter((op) => op.op === 'test')).toEqual([
			{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
			{ op: 'test', path: '/metadata/resourceVersion', value: version },
		])
		expect(operations.find((op) => op.path === '/metadata/annotations')).toBeDefined()
		await held.destroy()
	}, 30_000)

	it('does not erase an annotation another writer stamped in the window', async () => {
		// The window: this call read an object with no annotations, and before
		// its patch another holder fenced the workspace — a suspend carrying a
		// holder epoch onto an already-Suspended object writes `metadata` and
		// leaves `spec` alone, so the mode clause sees nothing. An
		// unconditional whole-map write would replace the map and silently
		// unfence a workspace somebody else had taken.
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		annotateBeforeNextJsonPatch = { [EPOCH_KEY]: '9' }
		template = buildTemplate({ image: 'namzu/agent:2' })

		const refusal = await openWorkspace({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(Error)
		expect((refusal as Error).name).toBe('KubernetesPatchNotAppliedError')
		// Nothing was written: the other holder's epoch stands, the workspace
		// is still asleep, and no pod was started for a caller that may no
		// longer be entitled to one.
		expect(annotationsOf(stored())).toEqual({ [EPOCH_KEY]: '9' })
		expect(modeOf(stored())).toBe('Suspended')
		expect(sandboxPatches()).toHaveLength(1)
		expect(livePodUid).toBeUndefined()
	}, 30_000)
})

describe('a refresh under a holder epoch', () => {
	it('carries both conditions in one body', async () => {
		const held = await openWorkspace({ epoch: 4 })
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2' })
		const patchesBefore = sandboxPatches().length

		await held.resume({ refreshPodTemplate: true, epoch: 4 })

		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		const refresh = sandboxPatches().at(-1) as RecordedRequest
		expect(refresh.contentType).toBe(JSON_PATCH)
		expect(patchOperations(refresh)).toEqual([
			{ op: 'test', path: EPOCH_POINTER, value: '4' },
			{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
			{ op: 'add', path: EPOCH_POINTER, value: '4' },
			{ op: 'add', path: MODE_CHANGED_POINTER, value: expect.any(String) },
			{ op: 'add', path: HASH_POINTER, value: expect.stringMatching(HASH_SHAPE) },
			{ op: 'add', path: '/spec/podTemplate', value: expectedPodTemplate(template) },
			{ op: 'add', path: '/spec/operatingMode', value: 'Running' },
		])
		expect(storedPodTemplate()).toEqual(expectedPodTemplate(template))
		await held.destroy()
	}, 30_000)

	it('is refused to a superseded holder, and writes no pod template', async () => {
		seedWorkspace({
			mode: 'Suspended',
			podTemplate: expectedPodTemplate(template),
			annotations: { [EPOCH_KEY]: '7' },
		})
		const createdTemplate = JSON.parse(JSON.stringify(storedPodTemplate())) as Json
		template = buildTemplate({ image: 'namzu/agent:2' })

		const refusal = await openWorkspace({ refreshPodTemplate: true, epoch: 4 }).catch(
			(err: unknown) => err,
		)

		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expect((refusal as KubernetesWorkspacePreconditionError).storedEpoch).toBe(7)
		expect(sandboxPatches()).toHaveLength(0)
		expect(storedPodTemplate()).toEqual(createdTemplate)
		expect(modeOf(stored())).toBe('Suspended')
	}, 20_000)
})

describe('a workspace deleted between the refused patch and the re-read', () => {
	// The re-read is what tells a lost race from a wrong patch, and it can find
	// nothing at all. That must not be reported as a lost race: "another
	// process resumed it first" sends the caller on to BIND that process's pod,
	// and there is no pod. What the caller hears instead is the 404 the re-read
	// got, naming the object — not a refusal about an absent template label,
	// and not a patch builder complaining it has nothing to condition a write
	// on, which are the two errors an absent object would have produced
	// downstream.
	it('surfaces the vanished object on the handle path, and starts nothing', async () => {
		const held = await openWorkspace()
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2' })
		const patchesBefore = sandboxPatches().length
		vanishBetweenPatchAndReread = true

		const refusal = await held.resume({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(Error)
		expect((refusal as Error).name).toBe('KubernetesAlreadyGoneError')
		// One attempt, and nothing came up under a name that no longer exists.
		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
		expect(livePodUid).toBeUndefined()
	}, 40_000)

	it('surfaces it on the adopt path too, binding no pod', async () => {
		seedWorkspace({ mode: 'Suspended', podTemplate: expectedPodTemplate(template) })
		template = buildTemplate({ image: 'namzu/agent:2' })
		vanishBetweenPatchAndReread = true

		const refusal = await openWorkspace({ refreshPodTemplate: true }).catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(Error)
		expect((refusal as Error).name).toBe('KubernetesAlreadyGoneError')
		expect(sandboxPatches()).toHaveLength(1)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
		expect(livePodUid).toBeUndefined()
	}, 30_000)
})

/**
 * #498's egress profile meets #486's refresh, and the meeting is the whole
 * point of these two cases.
 *
 * A profile is a pod LABEL: it is on the create POST's `spec.podTemplate`, it
 * is half of the translated policy's `podSelector`, and nothing on the
 * workspace path ever reads it back off the running pod. A refresh replaces
 * `/spec/podTemplate` WHOLE, so a refresh built from the template alone would
 * PATCH the label off the object — the replacement pod would come up selected
 * by no per-profile policy while `createKubernetesWorkspace` had already
 * reported the boundary verified, which is the one failure #498 must not have.
 * It would also take the stamped revision over a pod template no create ever
 * writes, so `templateCurrent` would report drift that no refresh could clear.
 *
 * The labels therefore travel on the HANDLE (`podLabels`), because a resume
 * happens long after the call that opened it, and through
 * `buildPodTemplateRefresh` on the adopt path.
 */
describe('a refresh under an egress profile', () => {
	beforeEach(() => {
		profiledEgress = {
			policy: { kind: 'deny-all' },
			profile: PROFILE,
			profileLabelKey: PROFILE_KEY,
		}
	})

	it('rebuilds a handle’s refresh with the labels it was opened under', async () => {
		const held = await openWorkspace()
		// The create stamped it; the question is what the resume does with it.
		expect((storedPodTemplate().metadata as Json).labels).toEqual({
			[TEMPLATE_LABEL]: TEMPLATE_NAME,
			[PROFILE_KEY]: PROFILE,
		})
		await held.suspend()
		template = buildTemplate({ image: 'namzu/agent:2' })

		await held.resume({ refreshPodTemplate: true })

		const refresh = sandboxPatches().at(-1) as RecordedRequest
		const written = patchOperations(refresh).find((op) => op.path === '/spec/podTemplate')
		expect(((written?.value as Json).metadata as Json).labels).toEqual({
			[TEMPLATE_LABEL]: TEMPLATE_NAME,
			[PROFILE_KEY]: PROFILE,
		})
		// The object, after the patch: the profile survived the whole-document
		// replacement, and so did the new image.
		expect((storedPodTemplate().metadata as Json).labels).toEqual({
			[TEMPLATE_LABEL]: TEMPLATE_NAME,
			[PROFILE_KEY]: PROFILE,
		})
		expect(((storedPodTemplate().spec as Json).containers as Json[])[0]?.image).toBe(
			'namzu/agent:2',
		)
		// And the revision agrees with what a create would stamp, so the
		// workspace does not report drift it cannot clear.
		expect(held.templateRevision).toBe(storedHash())
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 30_000)

	it('writes the configured profile onto a workspace that predates it, instead of refusing it', async () => {
		// The object was created before `config.egress.profile` existed, so its
		// pod template carries the template label alone — and an ordinary adopt
		// REFUSES it, because a pod carrying no profile label is selected by
		// none of the per-profile policies while create() would have reported
		// the boundary verified.
		const unprofiled: Json = {
			metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
			spec: expectedPodTemplate(template).spec as Json,
		}
		seedWorkspace({ mode: 'Suspended', podTemplate: unprofiled })

		const refusal = await openWorkspace().catch((err: unknown) => err)

		expect(refusal).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		expect((refusal as KubernetesWorkspaceMismatchError).field).toBe('egressProfile')
		expect(sandboxPatches()).toHaveLength(0)

		// With the option, the refusal is lifted for the same reason the
		// RuntimeClass one is: this call is ABOUT TO WRITE the configured
		// value. The patch is what has to carry it.
		const held = await openWorkspace({ refreshPodTemplate: true })

		const refresh = sandboxPatches().at(-1) as RecordedRequest
		expect(refresh.contentType).toBe(JSON_PATCH)
		const written = patchOperations(refresh).find((op) => op.path === '/spec/podTemplate')
		expect(((written?.value as Json).metadata as Json).labels).toEqual({
			[TEMPLATE_LABEL]: TEMPLATE_NAME,
			[PROFILE_KEY]: PROFILE,
		})
		expect((storedPodTemplate().metadata as Json).labels).toEqual({
			[TEMPLATE_LABEL]: TEMPLATE_NAME,
			[PROFILE_KEY]: PROFILE,
		})
		expect(held.templateCurrent).toBe(true)
		await held.destroy()
	}, 30_000)
})
