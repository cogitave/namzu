import { EventEmitter } from 'node:events'
import { lstat, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type LocalComputerCommandRunner, nodeCommandRunner } from '../engine.js'
import { resolveLocalPodmanEngine } from '../podman-machine.js'
import { startLocalSshForward } from '../ssh-forward.js'

vi.mock('node:fs/promises', () => ({
	realpath: vi.fn(async (path: string) => path),
	lstat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => true })),
}))
vi.mock('../ssh-forward.js', () => ({
	startLocalSshForward: vi.fn(async () => ({
		ports: [5001, 5002],
		assertAlive() {},
		async close() {},
	})),
}))
vi.mock('node:net', () => ({
	createConnection: vi.fn(() => {
		const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
		queueMicrotask(() => socket.emit('connect'))
		return socket
	}),
}))

function fixture() {
	const machines = [{ Name: 'local-pal-machine', VMType: 'wsl' }]
	const inspected = {
		Name: 'local-pal-machine',
		State: 'running',
		Rootful: true,
		ConfigDir: { Path: 'C:\\Users\\Operator\\.config\\containers\\podman\\machine\\wsl' },
		SSHConfig: {
			IdentityPath: 'C:\\Users\\Operator\\.local\\share\\containers\\podman\\machine\\machine',
			Port: 61234,
			RemoteUsername: 'user',
		},
		ConnectionInfo: { PodmanPipe: { Path: '\\\\.\\pipe\\local-pal-machine' } },
	}
	const connection = {
		Name: 'local-pal-machine-root',
		URI: 'ssh://root@127.0.0.1:61234/run/podman/podman.sock',
		Identity: inspected.SSHConfig.IdentityPath,
		IsMachine: true,
		ReadWrite: true,
	}
	const calls: {
		binary: string
		args: readonly string[]
		env?: NodeJS.ProcessEnv
		cwd?: string
	}[] = []
	const state = { registration: 'archlinux\r\nlocal-pal-machine\r\n', os: 'linux' }
	const runner: LocalComputerCommandRunner = {
		async run(binary, args, options) {
			calls.push({ binary, args, env: options?.env, cwd: options?.cwd })
			if (binary.endsWith('wsl.exe'))
				return args.includes('--exec') ? 'ssh-ed25519 fixture-public-key' : state.registration
			if (args[0] === 'machine' && args[1] === 'list') return JSON.stringify(machines)
			if (args[0] === 'machine' && args[1] === 'inspect') return JSON.stringify(inspected)
			if (args[0] === 'system') return JSON.stringify([connection])
			if (args[4] === 'info') return JSON.stringify({ host: { os: state.os } })
			return 'guest-allocation'
		},
	}
	vi.stubEnv('USERPROFILE', 'C:\\Users\\Operator')
	return {
		machines,
		inspected,
		connection,
		calls,
		state,
		options: {
			podmanMachine: 'local-pal-machine',
			podmanConnection: 'local-pal-machine-root',
			podmanBinary: 'C:\\Program Files\\Podman\\podman.exe',
			runner,
		},
	}
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

describe('explicit local Windows Podman machine admission', () => {
	it('pins initial and later native commands to the profile despite a WSL UNC caller directory', async () => {
		const f = fixture()
		const callerDirectory = '\\\\wsl.localhost\\archlinux\\home\\operator\\project'
		vi.spyOn(process, 'cwd').mockReturnValue(callerDirectory)
		const chdir = vi.spyOn(process, 'chdir')
		const engine = await resolveLocalPodmanEngine(f.options, undefined, 'win32')
		await engine.run(['run', 'fixture-image'])
		await engine.run(['stop', 'fixture-allocation'])
		await engine.forwardPorts!([4001, 4002], { onLost() {} })
		expect(f.calls.every((call) => call.cwd === 'C:\\Users\\Operator')).toBe(true)
		expect(f.calls.some((call) => call.args[0] === 'machine')).toBe(true)
		expect(f.calls.some((call) => call.args[4] === 'run')).toBe(true)
		expect(f.calls.some((call) => call.args[4] === 'stop')).toBe(true)
		expect(f.calls.filter((call) => call.binary.endsWith('wsl.exe'))).toHaveLength(2)
		expect(startLocalSshForward).toHaveBeenCalledWith(
			expect.objectContaining({ hostPublicKey: 'ssh-ed25519 fixture-public-key' }),
		)
		expect(chdir).not.toHaveBeenCalled()
		expect(process.cwd()).toBe(callerDirectory)
	})
	it('resolves explicit relative binary paths before pinning and retains bare PATH command names', async () => {
		const f = fixture()
		vi.spyOn(process, 'cwd').mockReturnValue('C:\\Caller\\project')
		await resolveLocalPodmanEngine(
			{ ...f.options, podmanBinary: '.\\tools\\podman.exe' },
			undefined,
			'win32',
		)
		expect(
			f.calls
				.filter((call) => !call.binary.endsWith('wsl.exe'))
				.every((call) => call.binary === 'C:\\Caller\\project\\tools\\podman.exe'),
		).toBe(true)
		f.calls.length = 0
		await resolveLocalPodmanEngine({ ...f.options, podmanBinary: 'podman' }, undefined, 'win32')
		expect(
			f.calls
				.filter((call) => !call.binary.endsWith('wsl.exe'))
				.every((call) => call.binary === 'podman'),
		).toBe(true)
	})
	it.each(['operator', '\\\\wsl.localhost\\archlinux\\home\\operator', 'C:operator'])(
		'refuses a non-native profile before invoking the engine: %s',
		async (profile) => {
			const f = fixture()
			vi.stubEnv('USERPROFILE', profile)
			await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
				'native Windows operator profile',
			)
			expect(f.calls).toHaveLength(0)
		},
	)
	it('refuses a profile whose real path is UNC or is not a directory before invoking the engine', async () => {
		const f = fixture()
		vi.mocked(realpath).mockResolvedValueOnce('\\\\server\\share\\operator')
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'native Windows operator profile',
		)
		vi.mocked(lstat).mockResolvedValueOnce({ isDirectory: () => false } as never)
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'native Windows operator profile',
		)
		expect(f.calls).toHaveLength(0)
	})
	it('pins the verified machine URL and identity without changing machine/default state', async () => {
		const f = fixture()
		vi.stubEnv('CONTAINER_HOST', 'ssh://unrelated-host/run/podman.sock')
		vi.stubEnv('CONTAINER_CONNECTION', 'unrelated')
		vi.stubEnv('CONTAINER_SSHKEY', 'foreign-key')
		const engine = await resolveLocalPodmanEngine(f.options, undefined, 'win32')
		expect(engine.endpoint).toBe('npipe:////./pipe/local-pal-machine')
		expect(createConnection).toHaveBeenCalledWith('\\\\.\\pipe\\local-pal-machine')
		await engine.run(['run', '--env', 'NAMZU_SANDBOX_TOKEN', 'fixture-image'], {
			env: { NAMZU_SANDBOX_TOKEN: 'private-token' },
		})
		const run = f.calls.at(-1)!
		expect(run.args.slice(0, 4)).toEqual([
			'--url',
			f.connection.URI,
			'--identity',
			f.connection.Identity,
		])
		expect(run.env?.CONTAINER_HOST).toBeUndefined()
		expect(run.env?.CONTAINER_CONNECTION).toBeUndefined()
		expect(run.env?.CONTAINER_SSHKEY).toBeUndefined()
		expect(run.args).not.toContain('private-token')
		expect(run.env?.NAMZU_SANDBOX_TOKEN).toBe('private-token')
		expect(
			f.calls.some(
				(call) =>
					call.args.includes('start') || call.args.includes('init') || call.args.includes('use'),
			),
		).toBe(false)
	})
	it('requires a Windows host, explicit names and locally derived transport', async () => {
		const f = fixture()
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'linux')).rejects.toThrow(
			'Windows WSL',
		)
		await expect(
			resolveLocalPodmanEngine({ ...f.options, podmanMachine: undefined }, undefined, 'win32'),
		).rejects.toThrow('explicitly')
		await expect(
			resolveLocalPodmanEngine(
				{ ...f.options, engineEndpoint: 'npipe:////./pipe/foreign' },
				undefined,
				'win32',
			),
		).rejects.toThrow('arbitrary engine endpoint')
		expect(f.calls).toHaveLength(0)
	})
	it.each([
		'tcp://127.0.0.1:61234',
		'ssh://root@remote-host:61234/run/podman/podman.sock',
		'ssh://user@127.0.0.1:61234/run/podman/podman.sock',
		'ssh://root@127.0.0.1:61235/run/podman/podman.sock',
		'ssh://root:password@127.0.0.1:61234/run/podman/podman.sock',
	])('refuses a connection outside the inspected machine: %s', async (uri) => {
		const f = fixture()
		f.connection.URI = uri
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'remote connections are refused',
		)
		expect(createConnection).not.toHaveBeenCalled()
	})
	it('refuses a plain remote connection even when its URI matches a machine', async () => {
		const f = fixture()
		f.connection.IsMachine = false
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'local WSL machine identity',
		)
	})
	it('requires local WSL registration, running state, pipe agreement and operator-owned files', async () => {
		const f = fixture()
		f.machines[0]!.VMType = 'hyperv'
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'Windows WSL provider',
		)
		f.machines[0]!.VMType = 'wsl'
		f.inspected.State = 'stopped'
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'start it explicitly',
		)
		f.inspected.State = 'running'
		f.state.registration = 'archlinux'
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'registered local WSL',
		)
		f.state.registration = 'local-pal-machine'
		f.inspected.ConnectionInfo.PodmanPipe.Path = '\\\\.\\pipe\\foreign-machine'
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'matching local Windows named pipe',
		)
		f.inspected.ConnectionInfo.PodmanPipe.Path = '\\\\.\\pipe\\local-pal-machine'
		vi.mocked(realpath).mockImplementationOnce(async (path) => path.toString())
		vi.mocked(realpath).mockResolvedValueOnce('C:\\Users\\Foreign\\machine')
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'inside the current Windows operator',
		)
		expect(createConnection).not.toHaveBeenCalled()
	})
	it('requires Linux on the verified machine', async () => {
		const f = fixture()
		f.state.os = 'windows'
		await expect(resolveLocalPodmanEngine(f.options, undefined, 'win32')).rejects.toThrow(
			'Linux containers',
		)
		expect(lstat).toHaveBeenCalled()
	})
	it('decodes native wsl.exe UTF-16LE output in the real shell-free runner', async () => {
		expect(
			await nodeCommandRunner.run(process.execPath, [
				'-e',
				'process.stdout.write(Buffer.from("local-machine\\r\\n", "utf16le"))',
			]),
		).toBe('local-machine\r\n')
	})
	it('uses the explicit cwd in the real shell-free runner', async () => {
		const directory = dirname(process.cwd())
		expect(
			await nodeCommandRunner.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
				cwd: directory,
			}),
		).toBe(directory)
	})
})
