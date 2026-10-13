import { describe, expect, it } from 'vitest'
import type { KubernetesBackendInternalConfig } from '../index.js'
import {
	assertWorkspaceAllocationResource,
	captureWorkspaceAllocation,
} from '../workspace-allocation.js'
import {
	assertWorkspaceExecutionContent,
	captureWorkspaceExecutionProfile,
	describeWorkspaceExecutionProfile,
	workspaceConfigForOriginalProfile,
} from '../workspace-profile.js'

const config = (): KubernetesBackendInternalConfig => ({
	access: {
		server: 'https://cluster.example',
		getToken: async () => 'credential',
	},
	namespace: 'native',
	sandboxTemplateName: 'native-files',
	agentPort: 1024,
	agentAddress: 'pod-ip',
	runtimeClassName: 'kata-vm-isolation',
	egress: {
		engine: 'core',
		policy: { kind: 'no-network' },
		networkPolicyName: 'native-no-network',
	},
})
const spec = () => ({
	podTemplate: {
		metadata: {
			labels: { template: 'native-files', actor: 'host' },
			annotations: { 'sidecar.istio.io/inject': 'false' },
		},
		spec: {
			runtimeClassName: 'kata-vm-isolation',
			containers: [
				{
					name: 'agent',
					image: `image@sha256:${'a'.repeat(64)}`,
					env: [
						{
							name: 'TOKEN',
							valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
						},
					],
					volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
				},
			],
		},
	},
	volumeClaimTemplates: [
		{
			metadata: { name: 'workspace' },
			spec: {
				volumeMode: 'Block',
				storageClassName: 'zrs',
				resources: { requests: { storage: '32Gi' } },
			},
		},
	],
})
const profile = () => describeWorkspaceExecutionProfile({ config: config(), ...spec() })

describe('original native execution content', () => {
	it('canonicalizes object keys and retains the effective content rather than a template name', () => {
		const original = profile()
		const body = spec()
		body.podTemplate.metadata.labels = {
			actor: 'host',
			template: 'native-files',
		}
		expect(describeWorkspaceExecutionProfile({ config: config(), ...body })).toEqual(original)
		body.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
		expect(describeWorkspaceExecutionProfile({ config: config(), ...body }).fingerprint).not.toBe(
			original.fingerprint,
		)
	})
	it('owns historical fields and refuses missing, extra and corrupt descriptors', () => {
		const input = { ...profile() }
		const captured = captureWorkspaceExecutionProfile(input)
		input.agentPort = 2048
		expect(captured.agentPort).toBe(1024)
		for (const invalid of [
			undefined,
			null,
			{},
			{ ...profile(), version: 2 },
			{ ...profile(), extra: true },
			{ ...profile(), fingerprint: '0'.repeat(64) },
			{ ...profile(), podTemplateHash: `sha256:${'b'.repeat(64)}` },
		])
			expect(() => captureWorkspaceExecutionProfile(invalid as never)).toThrow()
	})
	it('never restores current template/runtime/agent values into historical recovery', () => {
		const current = {
			...config(),
			sandboxTemplateName: 'next-image',
			runtimeClassName: 'runc',
			agentPort: 3000,
			agentAddress: 'service' as const,
			ingress: 'unverified' as const,
		}
		const recovered = workspaceConfigForOriginalProfile(current, profile())
		expect(recovered).toMatchObject({
			sandboxTemplateName: 'native-files',
			runtimeClassName: 'kata-vm-isolation',
			agentPort: 1024,
			agentAddress: 'pod-ip',
			ingress: { engine: 'core' },
		})
		expect(recovered.access).not.toBe(current.access)
		expect(recovered.access).toEqual(current.access)
		expect(() =>
			workspaceConfigForOriginalProfile({ ...current, namespace: 'other' }, profile()),
		).toThrow()
		expect(() =>
			workspaceConfigForOriginalProfile(
				{
					...current,
					access: {
						server: 'https://other.example',
						getToken: async () => 'new',
					},
				},
				profile(),
			),
		).toThrow()
	})
	it('credentials and operational timeouts do not change execution content', () => {
		expect(
			describeWorkspaceExecutionProfile({
				config: {
					...config(),
					readyTimeoutMs: 90000,
					access: {
						server: 'https://cluster.example',
						getToken: async () => 'rotated',
					},
				},
				...spec(),
			}),
		).toEqual(profile())
	})
	it.each([
		'runtime',
		'image',
		'init-image',
		'env-ref',
		'volume-ref',
		'ingress',
		'policy',
		'claims',
		'storage-class',
		'claim-source',
		'bound-claim',
		'policy-bypass',
		'policy-profile',
		'profile-key',
		'engine-mismatch',
		'pvc',
		'nfs',
		'image-volume',
	])('refuses an unqualified %s', (part) => {
		const input = { config: config(), ...spec() }
		if (part === 'runtime') input.config = { ...input.config, runtimeClassName: undefined }
		if (part === 'image') input.podTemplate.spec.containers[0]!.image = 'image:latest'
		if (part === 'init-image')
			Object.assign(input.podTemplate.spec, {
				initContainers: [{ name: 'init', image: 'init:latest' }],
			})
		if (part === 'env-ref')
			Object.assign(input.podTemplate.spec.containers[0]!, {
				envFrom: [{ configMapRef: { name: 'mutable' } }],
			})
		if (part === 'volume-ref')
			Object.assign(input.podTemplate.spec, {
				volumes: [{ name: 'mutable', secret: { secretName: 'current' } }],
			})
		if (part === 'ingress') input.config = { ...input.config, ingress: 'unverified' }
		if (part === 'policy')
			input.config = {
				...input.config,
				egress: {
					engine: 'core',
					policy: { kind: 'allow-all' },
					networkPolicyName: 'open',
				},
			}
		if (part === 'claims') input.volumeClaimTemplates = []
		if (part === 'storage-class')
			Object.assign(input.volumeClaimTemplates[0]!.spec, { storageClassName: undefined })
		if (part === 'claim-source')
			Object.assign(input.volumeClaimTemplates[0]!.spec, {
				dataSource: { kind: 'PersistentVolumeClaim', name: 'external' },
			})
		if (part === 'bound-claim')
			Object.assign(input.volumeClaimTemplates[0]!.spec, { volumeName: 'external' })
		if (part === 'policy-bypass')
			Object.assign(input.config.egress!, { verify: 'named-object-only' })
		if (part === 'policy-profile') Object.assign(input.config.egress!, { profile: 'native' })
		if (part === 'profile-key') Object.assign(input.config.egress!, { profileLabelKey: 'profile' })
		if (part === 'engine-mismatch')
			input.config = { ...input.config, ingress: { engine: 'cilium' } }
		if (['pvc', 'nfs', 'image-volume'].includes(part))
			Object.assign(input.podTemplate.spec, {
				volumes: [
					{
						name: 'external',
						...(part === 'pvc' ? { persistentVolumeClaim: { claimName: 'shared' } } : {}),
						...(part === 'nfs' ? { nfs: { server: 'files', path: '/' } } : {}),
						...(part === 'image-volume' ? { image: { reference: 'image:latest' } } : {}),
					},
				],
			})
		expect(() => describeWorkspaceExecutionProfile(input)).toThrow()
	})
	it('retains the original combined verification scope and supports only local explicit volumes', () => {
		const originalConfig: KubernetesBackendInternalConfig = {
			...config(),
			egress: { ...config().egress!, engine: 'cilium' },
			ingress: { engine: 'cilium' },
		}
		const body = spec()
		Object.assign(body.podTemplate.spec, {
			volumes: [
				{ name: 'scratch', emptyDir: {} },
				{ name: 'identity', downwardAPI: { items: [] } },
			],
		})
		const original = describeWorkspaceExecutionProfile({ config: originalConfig, ...body })
		expect(original.networkVerificationEngine).toBe('cilium')
		expect(workspaceConfigForOriginalProfile(config(), original)).toMatchObject({
			ingress: { engine: 'cilium' },
			egress: { engine: 'cilium', policy: { kind: 'no-network' } },
		})
	})
	it('refuses incomplete authority for a profile-marked resource and preserves legacy resources', () => {
		const allocation = { id: 'original', scopeFingerprint: 'c'.repeat(64) }
		const resource = {
			metadata: {
				annotations: {
					'sandbox.namzu.ai/allocation-id': allocation.id,
					'sandbox.namzu.ai/allocation-scope': allocation.scopeFingerprint,
				},
			},
			spec: spec(),
		}
		assertWorkspaceAllocationResource('work', allocation, resource)
		Object.assign(resource.metadata.annotations, {
			'sandbox.namzu.ai/allocation-profile': profile().fingerprint,
		})
		expect(() => assertWorkspaceAllocationResource('work', allocation, resource)).toThrow()
	})
	it.each(['image', 'runtime', 'claims', 'annotation'])(
		'compares actual retained %s despite an unchanged profile marker',
		(part) => {
			const original = profile()
			const body = spec()
			assertWorkspaceExecutionContent(original, body)
			if (part === 'image')
				body.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
			if (part === 'runtime') body.podTemplate.spec.runtimeClassName = 'runc'
			if (part === 'claims') body.volumeClaimTemplates[0]!.spec.resources.requests.storage = '64Gi'
			if (part === 'annotation')
				body.podTemplate.metadata.annotations['sidecar.istio.io/inject'] = 'true'
			const allocation = {
				id: 'original',
				scopeFingerprint: 'c'.repeat(64),
				executionProfile: original,
			}
			const resource = {
				metadata: {
					annotations: {
						'sandbox.namzu.ai/allocation-id': allocation.id,
						'sandbox.namzu.ai/allocation-scope': allocation.scopeFingerprint,
						'sandbox.namzu.ai/allocation-profile': original.fingerprint,
					},
				},
				spec: body,
			}
			expect(() => assertWorkspaceAllocationResource('work', allocation, resource)).toThrow()
		},
	)
	it('rejects an explicit absent profile instead of dropping it from allocation authority', () => {
		expect(() =>
			captureWorkspaceAllocation({
				id: 'original',
				scopeFingerprint: 'a'.repeat(64),
				executionProfile: null as never,
			}),
		).toThrow()
	})
})
