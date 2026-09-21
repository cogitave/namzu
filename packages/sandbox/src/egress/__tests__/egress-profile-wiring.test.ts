import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Sandbox } from '@namzu/sdk'
import type { DockerBackendInternalConfig } from '../../backends/docker/index.js'
import type { SandboxBackendOptions } from '../../index.js'

/**
 * `createSandboxProvider({ egressProfile })`, per backend.
 *
 * Every refusal here is synchronous and happens with nothing constructed: the
 * docker and firecracker builders are replaced with recorders, so a case that
 * expects a refusal also asserts that no backend was built, and a case that
 * expects a provider reads the exact options its `create()` was handed.
 *
 * This table is the one statement of what each backend supports. There is no
 * second copy of it in the package to drift from this one.
 */

const built: { readonly backend: string; readonly config: unknown }[] = []
const created: SandboxBackendOptions[] = []

function recorder(backend: string, config: unknown) {
	built.push({ backend, config })
	return {
		tier: backend === 'firecracker' ? ('microvm' as const) : ('container' as const),
		name: backend,
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			created.push(options)
			return {} as Sandbox
		},
	}
}

vi.mock('../../backends/docker/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../backends/docker/index.js')>()
	return {
		...actual,
		buildDockerBackend: (config: DockerBackendInternalConfig) => {
			// The real construction-time checks still run, so a refusal the
			// backend owns is observed exactly as a host would meet it.
			actual.buildDockerBackend(config)
			return recorder('docker', config)
		},
	}
})

vi.mock('../../backends/firecracker/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../backends/firecracker/index.js')>()
	return {
		...actual,
		buildFirecrackerBackend: (config: unknown) => recorder('firecracker', config),
	}
})

const { createSandboxProvider, SandboxEgressProfileError, kubernetesEgressFromProfile } =
	await import('../../index.js')

const layout = { outputs: { source: { type: 'hostDir' as const, hostPath: '/host/out' } } }
const docker = { tier: 'container' as const, image: 'namzu/sandbox:test' }
const firecracker = {
	tier: 'microvm' as const,
	service: 'self-hosted' as const,
	orchestratorEndpoint: 'https://fc.example',
	getToken: async () => 'token',
}
const kubernetes = {
	tier: 'microvm' as const,
	service: 'kubernetes' as const,
	namespace: 'ns',
	access: { server: 'https://cluster.example:6443', getToken: async () => 'token' },
	sandboxTemplateName: 'namzu-task',
}
const aci = {
	tier: 'container' as const,
	runtime: 'aci-standby-pool' as const,
	subscriptionId: 'sub',
	resourceGroup: 'rg',
	location: 'westeurope',
	standbyPoolResourceId: '/pools/p',
	containerGroupProfileResourceId: '/profiles/p',
	getArmToken: async () => 'token',
}
const github = {
	name: 'github',
	hosts: [{ host: 'GitHub.com' }, { host: '.githubusercontent.com' }],
}
const withPorts = { name: 'p', hosts: [{ host: 'api.example.com', ports: [443] }] }

function refusal(run: () => unknown) {
	try {
		run()
	} catch (error) {
		expect(error).toBeInstanceOf(SandboxEgressProfileError)
		expect(built).toEqual([])
		return error as InstanceType<typeof SandboxEgressProfileError>
	}
	throw new Error('expected a SandboxEgressProfileError, and nothing was thrown')
}

beforeEach(() => {
	built.length = 0
	created.length = 0
})

describe('no profile — every path is what it was', () => {
	it('hands the docker backend defaultEgress unchanged, and no profile', async () => {
		const defaultEgress = { kind: 'static' as const, allowedHosts: ['a.example.com'] }
		const provider = createSandboxProvider({ backend: docker, layout, defaultEgress })
		await provider.create()
		expect(created[0]?.egress).toBe(defaultEgress)
		expect((built[0]?.config as DockerBackendInternalConfig).egressProfile).toBeUndefined()
		expect(Object.keys(built[0]?.config as object)).not.toContain('egressProfile')
	})

	it('hands no egress at all when none was configured', async () => {
		await createSandboxProvider({ backend: firecracker }).create()
		expect(Object.keys(created[0] ?? {})).not.toContain('egress')
	})
})

describe('docker and runsc', () => {
	it('turns the profile into a static allowlist of the normalised hosts', async () => {
		await createSandboxProvider({ backend: docker, layout, egressProfile: github }).create()
		expect(created[0]?.egress).toEqual({
			kind: 'static',
			allowedHosts: ['github.com', '.githubusercontent.com'],
		})
		expect((built[0]?.config as DockerBackendInternalConfig).egressProfile?.name).toBe('github')
	})

	it('turns a profile with no hosts into deny-all', async () => {
		await createSandboxProvider({
			backend: { ...docker, runtime: 'runsc' },
			layout,
			egressProfile: { name: 'none', hosts: [] },
		}).create()
		expect(created[0]?.egress).toEqual({ kind: 'deny-all' })
	})

	it('refuses a brokered credential for a host outside the profile', () => {
		const error = refusal(() =>
			createSandboxProvider({
				backend: {
					...docker,
					brokeredCredentials: [
						{ host: 'github.com', header: 'authorization', value: 't' },
						{ host: 'gitlab.com', header: 'authorization', value: 't' },
					],
				},
				layout,
				egressProfile: github,
			}),
		)
		expect(error.code).toBe('conflicting-policy')
		expect(error.path).toBe('backend.brokeredCredentials[1].host')
		expect(error.backend).toBe('docker')
	})

	it('accepts a brokered credential for a host the profile covers', () => {
		expect(() =>
			createSandboxProvider({
				backend: {
					...docker,
					brokeredCredentials: [
						{ host: 'raw.githubusercontent.com', header: 'authorization', value: 't' },
					],
				},
				layout,
				egressProfile: github,
			}),
		).not.toThrow()
	})

	it('accepts ports, and hands the profile to the backend that enforces them', async () => {
		await createSandboxProvider({ backend: docker, layout, egressProfile: withPorts }).create()
		expect(created[0]?.egress).toEqual({ kind: 'static', allowedHosts: ['api.example.com'] })
		expect((built[0]?.config as DockerBackendInternalConfig).egressProfile?.hosts).toEqual([
			{ host: 'api.example.com', ports: [443] },
		])
	})
})

describe('firecracker', () => {
	it('turns the profile into the allowlist the orchestrator takes', async () => {
		await createSandboxProvider({ backend: firecracker, egressProfile: github }).create()
		expect(created[0]?.egress).toEqual({
			kind: 'static',
			allowedHosts: ['github.com', '.githubusercontent.com'],
		})
	})

	it('refuses ports, for which the wire has no field', () => {
		const error = refusal(() =>
			createSandboxProvider({ backend: firecracker, egressProfile: withPorts }),
		)
		expect(error.code).toBe('unsupported')
		expect(error.path).toBe('hosts[0].ports')
		expect(error.backend).toBe('firecracker')
	})
})

describe('refused outright', () => {
	it('refuses a profile beside defaultEgress', () => {
		const error = refusal(() =>
			createSandboxProvider({
				backend: docker,
				layout,
				egressProfile: github,
				defaultEgress: { kind: 'allow-all' },
			}),
		)
		expect(error.code).toBe('conflicting-policy')
		expect(error.path).toBe('defaultEgress')
	})

	it('refuses a profile on kubernetes and names the translator', () => {
		const error = refusal(() =>
			createSandboxProvider({ backend: kubernetes, egressProfile: github }),
		)
		expect(error.code).toBe('conflicting-policy')
		expect(error.message).toMatch(/kubernetesEgressFromProfile/)
	})

	it('refuses any profile on the ACI standby pool', () => {
		const error = refusal(() =>
			createSandboxProvider({ backend: aci, layout, egressProfile: { name: 'none', hosts: [] } }),
		)
		expect(error.code).toBe('unsupported')
		expect(error.backend).toBe('aci-standby-pool')
	})

	it('validates the profile before any backend is chosen', () => {
		const error = refusal(() =>
			createSandboxProvider({
				backend: docker,
				layout,
				egressProfile: { name: 'p', hosts: [{ host: '*' }] },
			}),
		)
		expect(error.code).toBe('invalid-host')
	})
})

describe('kubernetes through backend.egress', () => {
	it('wires a translated profile under cilium, ports included', () => {
		expect(() =>
			createSandboxProvider({
				backend: {
					...kubernetes,
					egress: kubernetesEgressFromProfile(withPorts, { engine: 'cilium' }),
				},
			}),
		).not.toThrow()
	})

	it('leaves a core engine with hosts to the backend’s own refusal', () => {
		expect(() =>
			createSandboxProvider({
				backend: { ...kubernetes, egress: kubernetesEgressFromProfile(github) },
			}),
		).toThrow(/FQDN-capable policy engine/)
	})
})
