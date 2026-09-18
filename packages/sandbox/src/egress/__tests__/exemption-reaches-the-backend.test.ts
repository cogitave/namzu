import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DockerBackendInternalConfig } from '../../backends/docker/index.js'

/**
 * A proxy knob has to reach the thing that builds the proxy.
 *
 * `allowInwardFor` is the only remedy an operator has when the address screen
 * starts refusing a private host their allowlist used to reach. If it stops at
 * `ContainerBackendConfig` and never arrives at the proxy, the screen is a
 * denial with no way out — and nothing downstream of `buildDockerBackend`
 * runs without a Docker daemon, so the first person to find out would be
 * whoever was watching production traffic get refused.
 *
 * `brokeredCredentials` is the same journey without a way to notice it went
 * wrong. It is declared on the internal backend config, read by
 * `egressProxyContainerConfig` (which puts it into the proxy container's
 * environment), and it is the point of the boundary: the sandbox holds a
 * placeholder and the real value is stamped on at the proxy. A provider that
 * dropped it would not fail — it would start a proxy that forwards every
 * request unauthenticated, and the operator would learn it from a 401 on the
 * far side. Both fields are forwarded by `createSandboxProvider`, and every
 * case here is about that plumbing rather than about what the backend does
 * with what it is handed.
 */

const built: DockerBackendInternalConfig[] = []

vi.mock('../../backends/docker/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../backends/docker/index.js')>()
	return {
		...actual,
		buildDockerBackend: (config: DockerBackendInternalConfig) => {
			built.push(config)
			return actual.buildDockerBackend(config)
		},
	}
})

const { createSandboxProvider } = await import('../../index.js')

/** The minimum a container layout has to declare. */
function layout() {
	return { outputs: { source: { type: 'hostDir' as const, hostPath: '/host/out' } } }
}

describe('the inward exemption reaches the backend that builds the proxy', () => {
	beforeEach(() => {
		built.length = 0
	})

	it('carries the exemption a host configured', () => {
		createSandboxProvider({
			backend: {
				tier: 'container',
				image: 'namzu/sandbox:test',
				allowInwardFor: ['.internal.example'],
			},
			layout: layout(),
		} as never)

		expect(built).toHaveLength(1)
		expect(built[0]?.allowInwardFor).toEqual(['.internal.example'])
	})

	it('leaves it absent when the host configured none, so the screen applies', () => {
		createSandboxProvider({
			backend: { tier: 'container', image: 'namzu/sandbox:test' },
			layout: layout(),
		} as never)

		expect(built[0]?.allowInwardFor).toBeUndefined()
	})

	it('carries it on the gVisor runtime too, which is a second call site', () => {
		// Two `buildDockerBackend` calls sit in the same function, and a
		// property added to one of them is the shape this repo has a
		// convention about: finding an emitter is not evidence that every
		// path reaches it.
		createSandboxProvider({
			backend: {
				tier: 'container',
				runtime: 'runsc',
				image: 'namzu/sandbox:test',
				allowInwardFor: ['registry.corp'],
			},
			layout: layout(),
		} as never)

		expect(built[0]?.allowInwardFor).toEqual(['registry.corp'])
	})
})

describe('the brokered credentials reach the backend that builds the proxy', () => {
	beforeEach(() => {
		built.length = 0
	})

	/** A credential shape the proxy would stamp on, with the real value in it. */
	function credential() {
		return {
			host: 'api.internal.example',
			header: 'authorization',
			value: 'Bearer sk-the-real-value',
		}
	}

	// No `as never` on these three: the cast is what the neighbouring cases
	// need to build a config the checker would otherwise reject, and it is
	// exactly what would hide the claim this half of the fix rests on — that
	// the field is on the PUBLIC container config a caller writes, not only on
	// the internal one the backend reads. With the cast gone, moving the field
	// back off `ContainerBackendConfig` stops this file compiling.
	it('carries the credentials a host brokered', () => {
		createSandboxProvider({
			backend: {
				tier: 'container',
				image: 'namzu/sandbox:test',
				brokeredCredentials: [credential()],
			},
			layout: layout(),
		})

		expect(built).toHaveLength(1)
		expect(built[0]?.brokeredCredentials).toEqual([credential()])
	})

	it('leaves them absent when the host brokered none, so the proxy stamps nothing', () => {
		createSandboxProvider({
			backend: { tier: 'container', image: 'namzu/sandbox:test' },
			layout: layout(),
		})

		// Length first: `Object.hasOwn({}, …)` is false, so without this the
		// case would pass on a build that never happened.
		expect(built).toHaveLength(1)
		// `hasOwn`, not `toBeUndefined`: an explicit `undefined` passes that
		// assertion too, and the guarded spread exists precisely to keep the
		// key off the object rather than present and empty.
		expect(Object.hasOwn(built[0] ?? {}, 'brokeredCredentials')).toBe(false)
	})

	it('carries them on the runsc runtime too, which is a second call site', () => {
		createSandboxProvider({
			backend: {
				tier: 'container',
				runtime: 'runsc',
				image: 'namzu/sandbox:test',
				brokeredCredentials: [credential()],
			},
			layout: layout(),
		})

		expect(built[0]?.brokeredCredentials).toEqual([credential()])
	})
})
