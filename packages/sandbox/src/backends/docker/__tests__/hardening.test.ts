import type { ResolvedContainerSandboxLayout } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { parseProxyConfig } from '../../../../egress-proxy/server.mjs'
import type { DockerBackendInternalConfig } from '../index.js'
import {
	assertCpuLimitIsRenderable,
	buildDockerRunArgs,
	egressProxyContainerConfig,
	renderWritableRootfsArgs,
	resolveNetwork,
} from '../index.js'

/**
 * `EgressPolicy` was accepted by the type, threaded through the options,
 * and silently ignored by this backend. That is worse than not supporting
 * it: a host that set `deny-all` believed the container had no network,
 * and it had whatever `config.network` said.
 */

describe('resolveNetwork', () => {
	it('leaves the configured network alone when no policy is supplied', () => {
		expect(resolveNetwork('bridge', undefined)).toBe('bridge')
	})

	it('keeps the network for deny-all, because the container is reached THROUGH it', () => {
		// This used to answer `'none'`, which reads as the strictest possible
		// answer and was in fact unusable: `--network none` removes the
		// interface the worker is reached on, not just the route out. What
		// makes the kept network a boundary is `assertNetworkCarriesThePolicy`,
		// which has its own file.
		expect(resolveNetwork('locked-down', { kind: 'deny-all' })).toBe('locked-down')
	})

	it('allow-all keeps the configured network', () => {
		expect(resolveNetwork('my-bridge', { kind: 'allow-all' })).toBe('my-bridge')
	})

	it('REFUSES a host allowlist rather than silently granting full access', () => {
		// This backend has no proxy to filter through. Downgrading a
		// restrictive policy to "allow everything" is the failure mode that
		// makes a security control worse than useless.
		expect(() =>
			resolveNetwork('bridge', { kind: 'static', allowedHosts: ['example.com'] }),
		).toThrow(/cannot enforce an egress policy/)

		expect(() => resolveNetwork('bridge', { kind: 'resolver', resolve: async () => [] })).toThrow(
			/cannot enforce an egress policy/,
		)
	})

	it('names what it can do, so the failure is actionable', () => {
		expect(() => resolveNetwork('bridge', { kind: 'static', allowedHosts: [] })).toThrow(/deny-all/)
	})
})

/**
 * The knobs a host sets have to arrive at the boundary.
 *
 * Everything past this function needs a running Docker daemon, so a config
 * field that never reached the proxy container would be caught by an operator
 * watching production traffic get denied — with no way to fix it, because the
 * escape hatch they were told to use is the one that went missing.
 *
 * The boundary is a container now (#398), so what has to arrive is a JSON blob
 * its entrypoint parses instead of an options object it is constructed from.
 * `egress-proxy/server.mjs`'s own test parses what this renders with the parser
 * the container uses, which is the other half of the pair.
 */
describe('egressProxyContainerConfig', () => {
	const hosts = ['api.example.com']

	it('carries the allowlist it was handed, as the policy the container gets', () => {
		expect(egressProxyContainerConfig({}, hosts, 2025).allowedHosts).toEqual(hosts)
	})

	it('carries the port it will listen on', () => {
		// The port is fixed by the backend's constant and read by the sandbox's
		// `HTTP_PROXY` value; a container listening somewhere else is a boundary
		// nothing can reach.
		expect(egressProxyContainerConfig({}, hosts, 2025).port).toBe(2025)
	})

	it('carries the inward exemption to the boundary', () => {
		const config = egressProxyContainerConfig({ allowInwardFor: ['inside.example'] }, hosts, 2025)
		expect(config.allowInwardFor).toEqual(['inside.example'])
	})

	it('leaves it absent when the host named none, so the screen applies', () => {
		// The other half of the same fact: a field populated whatever the host
		// passed would satisfy the case above and say nothing.
		expect(egressProxyContainerConfig({}, hosts, 2025).allowInwardFor).toBeUndefined()
	})

	it('carries the brokered credentials too', () => {
		const credential = { host: 'api.example.com', header: 'authorization', value: 'real' }
		const config = egressProxyContainerConfig({ brokeredCredentials: [credential] }, hosts, 2025)
		expect(config.credentials).toEqual([credential])
	})

	it('names the network alias as itself, so the loop guard closes', () => {
		// Bound to 0.0.0.0 inside its container, the proxy cannot tell from the
		// request line that a target naming `namzu-egress` is itself — and
		// forwarding that request would make it call itself until the process
		// ran out of sockets.
		expect(egressProxyContainerConfig({}, hosts, 2025).selfNames).toEqual(['namzu-egress'])
	})

	it('is accepted by the parser the container actually runs', () => {
		// The cross-boundary fact this file's docblock above claims, and the
		// first cut of this change did not test: this side serialises, that side
		// parses, and a field renamed or reshaped on one side alone has to fail
		// here rather than start a boundary that enforces something nobody
		// wrote. `parseProxyConfig` is imported from the entrypoint's own file,
		// so the parser under test is the one the container executes — not a
		// second reading of the same shape.
		//
		// The values are the awkward ones on purpose: a credential value with a
		// quote and a backslash in it, and a leading-dot allowlist entry, which
		// are the two shapes a hand-rolled serialisation gets wrong.
		const credential = { host: 'api.example.com', header: 'authorization', value: 'a"b\\c' }
		const config = egressProxyContainerConfig(
			{ brokeredCredentials: [credential], allowInwardFor: ['inside.example'] },
			['.example.com', 'api.example.com'],
			2025,
		)

		const parsed = parseProxyConfig(JSON.stringify(config))
		expect(parsed.port).toBe(2025)
		expect(parsed.allowedHosts).toEqual(['.example.com', 'api.example.com'])
		expect(parsed.credentials).toEqual([credential])
		expect(parsed.allowInwardFor).toEqual(['inside.example'])
		expect(parsed.selfNames).toEqual(['namzu-egress'])
	})

	it('sends a credential through that round trip without mangling it', () => {
		// The narrower version of the same fact, asserted on the value that is
		// hardest to keep intact: a token with a quote and a backslash survives
		// being serialised by this side and parsed by that one, byte for byte.
		const credential = {
			host: 'api.example.com',
			header: 'authorization',
			value: 'Bearer a"b\\c\n',
		}
		const config = egressProxyContainerConfig({ brokeredCredentials: [credential] }, ['x'], 2025)
		const parsed = parseProxyConfig(JSON.stringify(config))
		expect(parsed.credentials[0]?.value).toBe(credential.value)
	})
})

/**
 * The other half of the parser's contract: the configurations it must refuse,
 * and what a refusal is allowed to say.
 *
 * These run in-process, which is the point of the `IS_ENTRYPOINT` guard in
 * `server.mjs`: a refusal used to call `process.exit(1)`, so importing this
 * parser and handing it a bad config took the vitest worker down instead of
 * failing an assertion (observed, before the guard). The container's own
 * behaviour is unchanged — it runs the file as its `CMD` — and
 * `egress-proxy/__tests__/server.test.js` is where the exit code is asserted,
 * as a subprocess.
 */
describe('parseProxyConfig — what a refusal may say', () => {
	function thrownBy(run: () => unknown): string {
		try {
			run()
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
		throw new Error('expected the call to throw')
	}

	it('refuses a configuration that is not JSON without quoting it back', () => {
		// V8's own message for this class of error embeds a window of the INPUT:
		// all of it when it is short enough, as asserted here on the raw
		// `JSON.parse`, and a slice of it otherwise. The input in production is
		// the whole policy — brokered credential values included — and the
		// message goes to the container's stderr, which is what `docker logs`
		// shows and what a deployment may ship to a collector. So the refusal
		// keeps what is safe to say (where the parse stopped, when V8 reports
		// one) and drops everything else.
		expect(() => JSON.parse('[super-secret-token]')).toThrow(/super-secret-token/)
		expect(thrownBy(() => JSON.parse('[super-secret-token]'))).toContain('super-secret-token')

		const refused =
			'{"allowedHosts":[],"credentials":[{"value":"super-secret-token"}],"x":super-secret-token}'
		const message = thrownBy(() => parseProxyConfig(refused))
		expect(message).toMatch(/is not valid JSON/)
		expect(message).not.toContain('super-secret-token')
		expect(message).not.toContain('allowedHosts')
	})

	it('refuses an unset configuration by name, without reading the process environment', () => {
		// The value is a parameter, so this is a refusal and not a fallback:
		// the entrypoint is the only caller that reads the environment.
		expect(thrownBy(() => parseProxyConfig(undefined))).toMatch(/is not set/)
		expect(thrownBy(() => parseProxyConfig(''))).toMatch(/is not set/)
	})
})

/**
 * The container tier's hardening baseline, pinned as argv.
 *
 * Every one of these flags is a claim about a container nobody in the test
 * suite starts. Before this, the baseline was reachable only through
 * `spawnDockerSandbox`, so the way to find out what this backend confines was
 * to read the file — and the way to lose a flag was to edit it and watch
 * production. An argv comparison is not a substitute for starting a container;
 * it is the part that a change to the baseline has to get past on purpose.
 */

const layout: ResolvedContainerSandboxLayout = {
	outputs: {
		source: { type: 'hostDir', hostPath: '/h/out' },
		containerPath: '/mnt/user-data/outputs',
	},
	uploads: {
		source: { type: 'hostDir', hostPath: '/h/up' },
		containerPath: '/mnt/user-data/uploads',
	},
	scratch: {
		source: { type: 'hostDir', hostPath: '/h/scratch' },
		containerPath: '/mnt/user-data/scratch',
	},
}

function backendConfig(
	overrides: Partial<DockerBackendInternalConfig> = {},
): DockerBackendInternalConfig {
	return { image: 'namzu-sandbox:latest', layout, ...overrides }
}

/**
 * The credential argv pins below do NOT contain, and that is the point.
 *
 * The worker's token is rendered as a valueless `--env NAMZU_SANDBOX_TOKEN`
 * for docker to resolve out of the CLI's own environment, so no value of it
 * can appear in a pinned array — because no value of it appears in the argv
 * at all. A literal used to stand here; it is gone rather than kept, since
 * a constant named for a secret that the argv no longer carries is the kind
 * of line a later edit reintroduces verbatim.
 * `the-worker-credential-is-minted-per-instance.test.ts` asserts the
 * valueless form and the CLI environment behind it, through the real create
 * path.
 */

function argv(
	config: DockerBackendInternalConfig = backendConfig(),
	options: Parameters<typeof buildDockerRunArgs>[0]['options'] = { workingDirectory: '/workspace' },
): string[] {
	return buildDockerRunArgs({
		config,
		options,
		containerName: 'namzu-sandbox-abc',
		network: 'namzu-tasks',
		hostReachability: 'host-port',
	})
}

const SCRATCH_OPTIONS = 'nosuid,nodev,exec,mode=1777'

describe('buildDockerRunArgs — the baseline', () => {
	it('pins the whole argv for a default config', () => {
		// Exact equality on purpose. `expect.arrayContaining` would let a flag
		// be added and another dropped in the same edit; this fails on both.
		expect(argv()).toEqual([
			'run',
			'--detach',
			'--rm',
			'--name',
			'namzu-sandbox-abc',
			'--network',
			'namzu-tasks',
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--ipc',
			'private',
			'--read-only',
			'--tmpfs',
			`/tmp:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/var/tmp:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/workspace:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/home/namzu:${SCRATCH_OPTIONS}`,
			'--volume',
			'/h/out:/mnt/user-data/outputs:rw',
			'--volume',
			'/h/up:/mnt/user-data/uploads:ro',
			'--volume',
			'/h/scratch:/mnt/user-data/scratch:rw',
			'--env',
			'NAMZU_SANDBOX_WORKSPACE=/mnt/user-data/outputs',
			'--env',
			'NAMZU_SANDBOX_READ_ROOTS=/mnt/user-data/outputs:/mnt/user-data/uploads:/mnt/user-data/scratch',
			'--env',
			'NAMZU_SANDBOX_WRITE_ROOTS=/mnt/user-data/outputs:/mnt/user-data/scratch',
			'--publish',
			'127.0.0.1::2024',
			'--env',
			'NAMZU_SANDBOX_TOKEN',
			'namzu-sandbox:latest',
		])
	})

	it('pins the whole argv for a writable root filesystem, which is not the old argv', () => {
		// `readOnlyRootfs: false` is the only switch here, and what it switches
		// off is `--read-only` and the tmpfs list beside it. Pinned as the whole
		// array rather than as "does not contain --read-only", because the
		// failure worth catching is not that flag coming back: it is
		// `--cap-drop=ALL`, `no-new-privileges` or `--ipc private` being moved
		// into the branch that renders it, which would hand a host that asked
		// only for a writable filesystem an argv with no capability drop in it.
		// So all three are asserted present, in place, exactly as the default
		// case asserts them.
		expect(argv(backendConfig({ readOnlyRootfs: false }))).toEqual([
			'run',
			'--detach',
			'--rm',
			'--name',
			'namzu-sandbox-abc',
			'--network',
			'namzu-tasks',
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--ipc',
			'private',
			'--volume',
			'/h/out:/mnt/user-data/outputs:rw',
			'--volume',
			'/h/up:/mnt/user-data/uploads:ro',
			'--volume',
			'/h/scratch:/mnt/user-data/scratch:rw',
			'--env',
			'NAMZU_SANDBOX_WORKSPACE=/mnt/user-data/outputs',
			'--env',
			'NAMZU_SANDBOX_READ_ROOTS=/mnt/user-data/outputs:/mnt/user-data/uploads:/mnt/user-data/scratch',
			'--env',
			'NAMZU_SANDBOX_WRITE_ROOTS=/mnt/user-data/outputs:/mnt/user-data/scratch',
			'--publish',
			'127.0.0.1::2024',
			'--env',
			'NAMZU_SANDBOX_TOKEN',
			'namzu-sandbox:latest',
		])
	})

	it('passes --runtime only when the host named one, with its value', () => {
		// `--runtime` is the flag that decides which container runtime creates
		// the sandbox at all — `runsc` is gVisor — and the value is asserted in
		// position rather than by containment, because a `--runtime` whose value
		// went missing is a docker invocation that reads the image name as the
		// runtime and the next token as the image.
		expect(argv()).not.toContain('--runtime')
		const withRuntime = argv(backendConfig({ runtime: 'runsc' }))
		expect(withRuntime[withRuntime.indexOf('--runtime') + 1]).toBe('runsc')
	})

	it('never renders a privilege grant, whatever the config carries', () => {
		const rendered = argv(backendConfig({ labels: { 'acme.task-id': 't1' }, cpuLimit: 2 }), {
			workingDirectory: '/workspace',
			memoryLimitMb: 512,
			maxProcesses: 64,
			env: { FOO: 'bar' },
		})
		// The two flags that would undo the baseline, and the one that would
		// look like hardening while removing it. `seccomp=unconfined` is the
		// shape this backend must never emit by accident: docker's default
		// profile is what filters a container's syscalls, and the only way to
		// lose it is to ask.
		expect(rendered).not.toContain('--privileged')
		expect(rendered.filter((arg) => arg.includes('seccomp'))).toEqual([])
		expect(rendered.filter((arg) => arg.includes('cap-add'))).toEqual([])
		expect(rendered.join(' ')).not.toContain('--userns')
		// The one `--security-opt` is the baseline's, not a `seccomp=` that
		// rode in on it. It is rendered `=`-joined, which is how it has always
		// been passed, so the assertion is on the whole token.
		expect(rendered.filter((arg) => arg.startsWith('--security-opt'))).toEqual([
			'--security-opt=no-new-privileges',
		])
	})

	it('renders the three resource bounds together, and only when asked', () => {
		const bounded = argv(backendConfig({ cpuLimit: 1.5 }), {
			workingDirectory: '/workspace',
			memoryLimitMb: 512,
			maxProcesses: 64,
		})
		// Sliced from `--memory` to the end, so the credential's `--env` entry
		// is pinned here too — it is the last thing before the image, rendered
		// valueless for docker to resolve out of the CLI's environment, and
		// last because a host-supplied value under the same name must not be
		// able to displace the one its own client sends.
		expect(bounded.slice(bounded.indexOf('--memory'))).toEqual([
			'--memory',
			'512m',
			'--pids-limit',
			'64',
			'--cpus',
			'1.5',
			'--env',
			'NAMZU_SANDBOX_TOKEN',
			'namzu-sandbox:latest',
		])

		// A fraction is not rounded, and an unset limit is not a default bound
		// nobody chose: the same argv without the knobs has none of the three.
		const unbounded = argv()
		expect(unbounded.join(' ')).not.toContain('--cpus')
		expect(unbounded.join(' ')).not.toContain('--memory')
		expect(unbounded.join(' ')).not.toContain('--pids-limit')
	})

	it('passes --user only when the host named one', () => {
		expect(argv()).not.toContain('--user')
		// The default is the image's own `USER` — the reference image runs as
		// namzu — so an unset field is not "running as root".
		const asUser = argv(backendConfig({ runAsUser: '1000:1000' }))
		expect(asUser[asUser.indexOf('--user') + 1]).toBe('1000:1000')
	})

	it('keeps the image last, so nothing after it is read as a flag', () => {
		const rendered = argv(backendConfig({ cpuLimit: 1 }), {
			workingDirectory: '/workspace',
			env: { Z: '1' },
		})
		expect(rendered[rendered.length - 1]).toBe('namzu-sandbox:latest')
		expect(rendered.slice(0, -1).every((arg) => arg !== 'namzu-sandbox:latest')).toBe(true)
	})

	it('renders the proxy boundary as environment when a proxy is running', () => {
		const rendered = buildDockerRunArgs({
			config: backendConfig(),
			options: { workingDirectory: '/workspace' },
			containerName: 'namzu-sandbox-abc',
			network: 'namzu-tasks',
			hostReachability: 'container-network',
			egressProxyPort: 2025,
		})
		expect(rendered).toContain('--env')
		expect(rendered).toContain('HTTP_PROXY=http://namzu-egress:2025')
		expect(rendered).toContain('https_proxy=http://namzu-egress:2025')
		// container-network publishes no host port, and an absent proxy leaves
		// no proxy environment behind — the two omissions are different facts.
		expect(rendered).not.toContain('--publish')
		expect(argv().join(' ')).not.toContain('HTTP_PROXY')
	})

	it('never renders `--add-host`, and never names `host-gateway`', () => {
		// This is the flag the whole change removes (#398). `--add-host
		// namzu-egress:host-gateway` put the name in the sandbox's hosts file
		// pointing at the docker host, where the proxy used to listen on
		// loopback — a route out of the sandbox that went somewhere other than
		// the boundary, next to an allowlist enforced by an environment
		// variable the sandbox could decline to read. The name resolves now
		// because the proxy is a container on the sandbox's own network
		// (`renderEgressProxyAttachArgs`), which needs no alias file.
		//
		// Asserted on the argv WITH a proxy, because that is the only argv
		// that ever carried it: a test on the default argv would pass whether
		// or not the flag came back.
		const withProxy = buildDockerRunArgs({
			config: backendConfig(),
			options: { workingDirectory: '/workspace' },
			containerName: 'namzu-sandbox-abc',
			network: 'namzu-tasks',
			hostReachability: 'container-network',
			egressProxyPort: 2025,
		})
		expect(withProxy).not.toContain('--add-host')
		expect(withProxy.join(' ')).not.toContain('host-gateway')
		expect(withProxy.join(' ')).not.toContain('host.docker.internal')
	})
})

describe('renderWritableRootfsArgs — what stays writable', () => {
	it('mounts the documented set, in a stable order', () => {
		expect(renderWritableRootfsArgs(backendConfig())).toEqual([
			'--tmpfs',
			`/tmp:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/var/tmp:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/workspace:${SCRATCH_OPTIONS}`,
			'--tmpfs',
			`/home/namzu:${SCRATCH_OPTIONS}`,
		])
	})

	it('skips a path the layout already mounts, rather than mounting it twice', () => {
		// Docker refuses two mounts at one destination ("Duplicate mount
		// point"), and the bind the host asked for is the one that has to win.
		const mounted = backendConfig({
			layout: {
				...layout,
				outputs: { source: { type: 'hostDir', hostPath: '/h/in' }, containerPath: '/workspace' },
			},
		})
		const rendered = renderWritableRootfsArgs(mounted)
		expect(rendered).not.toContain(`/workspace:${SCRATCH_OPTIONS}`)
		expect(rendered).toContain(`/tmp:${SCRATCH_OPTIONS}`)
	})

	it('adds the paths a host names, and does not repeat a default it names twice', () => {
		expect(renderWritableRootfsArgs(backendConfig({ writableRootfsPaths: ['/opt'] }))).toContain(
			`/opt:${SCRATCH_OPTIONS}`,
		)
		// A host that names /tmp gets one mount, not two.
		const repeated = renderWritableRootfsArgs(backendConfig({ writableRootfsPaths: ['/tmp'] }))
		expect(repeated.filter((arg) => arg.startsWith('/tmp:'))).toHaveLength(1)
	})

	it('refuses a host path the layout mounts, because two requests contradict', () => {
		expect(() =>
			renderWritableRootfsArgs(backendConfig({ writableRootfsPaths: ['/mnt/user-data/outputs'] })),
		).toThrow(/Duplicate mount point/)
	})

	it('refuses a path that is not a normalised absolute path', () => {
		// The last three are the same directory as a default this backend
		// mounts, spelled so that the collision check cannot see it — docker
		// would then refuse the container at spawn over a duplicate mount.
		for (const path of ['workspace', '/', '/tmp/../etc', '', '/tmp/', '//tmp', '/tmp/.']) {
			expect(() =>
				renderWritableRootfsArgs(backendConfig({ writableRootfsPaths: [path] })),
			).toThrow(/not a normalised absolute path/)
		}
	})

	it('sees a layout path spelled another way as the directory it is', () => {
		// The concrete break: `containerPath: '/tmp/'` and the `/tmp` tmpfs
		// default are ONE destination to moby, which cleans a mount target before
		// it compares it, so an exact-string check that let this through would
		// emit `--tmpfs /tmp:...` and a bind at `/tmp/` both, and the daemon
		// would refuse the container at create with `Duplicate mount point:
		// /tmp` — the failure this guard is here to prevent, arriving at spawn on
		// the one path no test in this repository can reach. Nothing here is
		// refused: the default is what gives way, since the host's own bind is
		// the mount that has to win.
		const spelled = (containerPath: string) =>
			backendConfig({
				layout: {
					...layout,
					outputs: { source: { type: 'hostDir', hostPath: '/h/out' }, containerPath },
				},
			})
		for (const spelling of ['/tmp/', '//tmp', '/tmp/.', '/tmp//', '/tmp/./']) {
			const rendered = renderWritableRootfsArgs(spelled(spelling))
			expect(rendered).not.toContain(`/tmp:${SCRATCH_OPTIONS}`)
			expect(rendered).toContain(`/var/tmp:${SCRATCH_OPTIONS}`)
		}

		// The same fact from the other side: a host entry naming the directory a
		// layout mount reduces to is the collision, whatever the layout wrote.
		expect(() =>
			renderWritableRootfsArgs(
				backendConfig({
					layout: {
						...layout,
						outputs: { source: { type: 'hostDir', hostPath: '/h/out' }, containerPath: '/opt/' },
					},
					writableRootfsPaths: ['/opt'],
				}),
			),
		).toThrow(/Duplicate mount point/)
	})

	it('is empty when the read-only root filesystem is off, and so is --read-only', () => {
		const writableRoot = backendConfig({ readOnlyRootfs: false })
		expect(renderWritableRootfsArgs(writableRoot)).toEqual([])
		expect(argv(writableRoot)).not.toContain('--read-only')
		expect(argv(writableRoot).join(' ')).not.toContain('--tmpfs')
	})

	it('refuses writable paths beside a writable root filesystem', () => {
		// Accepting them would be a control that is silently not applied.
		expect(() =>
			renderWritableRootfsArgs(
				backendConfig({ readOnlyRootfs: false, writableRootfsPaths: ['/opt'] }),
			),
		).toThrow(/readOnlyRootfs: false/)
	})
})

describe('assertCpuLimitIsRenderable', () => {
	it('accepts what docker accepts', () => {
		expect(() => assertCpuLimitIsRenderable(undefined)).not.toThrow()
		expect(() => assertCpuLimitIsRenderable(1)).not.toThrow()
		expect(() => assertCpuLimitIsRenderable(0.5)).not.toThrow()
	})

	it('refuses a bound the daemon would reject or misread', () => {
		// Each of these renders into the argv as text, and none of them means
		// what a host writing it would have meant: moby reads `NanoCPUs` of `0`
		// as NO limit, the opposite of a bound of zero, and a negative, `NaN` or
		// `Infinity` is refused by the daemon or turned into a bound nobody asked
		// for. What is deliberately NOT checked here is the daemon's upper bound
		// — above its own host's CPU count — because it is not knowable from
		// this process; the function's own comment says why.
		for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => assertCpuLimitIsRenderable(limit)).toThrow(/cpuLimit must be/)
		}
	})
})
