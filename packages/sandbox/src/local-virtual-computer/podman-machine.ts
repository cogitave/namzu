import { lstat, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { win32 } from 'node:path'
import {
	type LocalComputerCommandRunner,
	LocalComputerSetupError,
	type LocalEngine,
	nodeCommandRunner,
} from './engine.js'
import { startLocalSshForward } from './ssh-forward.js'

interface PodmanMachineOptions {
	readonly podmanBinary?: string
	readonly podmanMachine?: string
	readonly podmanConnection?: string
	readonly engineEndpoint?: string
	readonly runner?: LocalComputerCommandRunner
}

async function confirmLocalPipe(path: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted()
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(path)
		const abort = () => {
			socket.destroy()
			reject(signal?.reason)
		}
		const finish = (error?: Error) => {
			signal?.removeEventListener('abort', abort)
			socket.destroy()
			if (error)
				reject(
					new LocalComputerSetupError(
						'The selected local Podman machine pipe is unavailable; start that machine explicitly',
					),
				)
			else resolve()
		}
		socket.once('connect', () => finish())
		socket.once('error', finish)
		signal?.addEventListener('abort', abort, { once: true })
		if (signal?.aborted) abort()
	})
}

function insideProfile(path: string, profile: string): boolean {
	const relative = win32.relative(profile, path)
	return !win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\')
}

/**
 * Admit only a registered Windows WSL Podman machine. Its SSH connection is a
 * local machine transport, not permission to select an arbitrary remote daemon.
 * Capture its verified URL and identity so later named-connection edits cannot
 * redirect an allocation. Never start, initialize or configure the machine.
 */
export async function resolveLocalPodmanEngine(
	options: PodmanMachineOptions,
	signal?: AbortSignal,
	platform: NodeJS.Platform = process.platform,
): Promise<LocalEngine> {
	if (platform !== 'win32')
		throw new LocalComputerSetupError(
			'The Podman computer adapter requires a locally registered Windows WSL machine',
		)
	const machineName = options.podmanMachine
	const connectionName = options.podmanConnection
	if (
		!machineName ||
		!connectionName ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(machineName) ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(connectionName)
	)
		throw new LocalComputerSetupError(
			'Select an existing Podman machine and its registered connection explicitly',
		)
	if (options.engineEndpoint)
		throw new LocalComputerSetupError(
			'Podman machine transport is verified from local registration; an arbitrary engine endpoint is refused',
		)
	const selectedBinary = options.podmanBinary ?? 'podman'
	const binary = /[\\/]|^[a-zA-Z]:/.test(selectedBinary)
		? win32.resolve(process.cwd(), selectedBinary)
		: selectedBinary
	// Native Podman probes /proc/self/uid_map even in remote mode. A WSL UNC
	// caller directory produces ERROR_DIRECTORY rather than a missing file,
	// which Podman treats as fatal. Pin this transport to a native directory
	// without changing the embedding application's working directory.
	const profile = process.env.USERPROFILE
	if (!profile || !/^[a-zA-Z]:[\\/]/.test(profile))
		throw new LocalComputerSetupError(
			'The Podman machine requires an existing native Windows operator profile directory',
		)
	const realProfile = await realpath(profile)
	if (!/^[a-zA-Z]:[\\/]/.test(realProfile) || !(await lstat(realProfile)).isDirectory())
		throw new LocalComputerSetupError(
			'The Podman machine requires an existing native Windows operator profile directory',
		)
	const runner = options.runner ?? nodeCommandRunner
	const machines = JSON.parse(
		await runner.run(binary, ['machine', 'list', '--format', 'json'], {
			signal,
			cwd: realProfile,
		}),
	) as { Name?: string; VMType?: string }[]
	if (machines.find((machine) => machine.Name === machineName)?.VMType !== 'wsl')
		throw new LocalComputerSetupError(
			'The selected Podman machine must be registered locally with the Windows WSL provider',
		)
	const inspected = JSON.parse(
		await runner.run(binary, ['machine', 'inspect', machineName, '--format', '{{json .}}'], {
			signal,
			cwd: realProfile,
		}),
	) as {
		Name?: string
		State?: string
		Rootful?: boolean
		ConfigDir?: { Path?: string }
		SSHConfig?: { IdentityPath?: string; Port?: number; RemoteUsername?: string }
		ConnectionInfo?: { PodmanPipe?: { Path?: string } }
	}
	if (inspected.Name !== machineName || inspected.State !== 'running')
		throw new LocalComputerSetupError(
			'The selected Podman machine is stopped or unavailable; start it explicitly',
		)
	const registrations = await runner.run(
		win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'),
		['--list', '--quiet'],
		{ signal, cwd: realProfile },
	)
	if (
		!registrations
			.split(/\r?\n/)
			.some((name) => name.trim().toLowerCase() === machineName.toLowerCase())
	)
		throw new LocalComputerSetupError(
			'The selected Podman machine is not a registered local WSL distribution',
		)
	const pipe = inspected.ConnectionInfo?.PodmanPipe?.Path
	if (pipe !== `\\\\.\\pipe\\${machineName}`)
		throw new LocalComputerSetupError(
			'The Podman machine must own its matching local Windows named pipe',
		)
	const identity = inspected.SSHConfig?.IdentityPath
	const configDir = inspected.ConfigDir?.Path
	if (!identity || !configDir || !win32.isAbsolute(identity) || !win32.isAbsolute(configDir))
		throw new LocalComputerSetupError(
			'The Podman machine must belong to the current Windows operator profile',
		)
	const [realIdentity, realConfig] = await Promise.all([
		realpath(win32.normalize(identity)),
		realpath(win32.normalize(configDir)),
	])
	if (
		!insideProfile(realIdentity, realProfile) ||
		!insideProfile(realConfig, realProfile) ||
		!(await lstat(realIdentity)).isFile()
	)
		throw new LocalComputerSetupError(
			'The Podman machine identity and configuration must remain inside the current Windows operator profile',
		)
	const connections = JSON.parse(
		await runner.run(binary, ['system', 'connection', 'list', '--format', 'json'], {
			signal,
			cwd: realProfile,
		}),
	) as {
		Name?: string
		URI?: string
		Identity?: string
		IsMachine?: boolean
		ReadWrite?: boolean
	}[]
	const connection = connections.find((candidate) => candidate.Name === connectionName)
	let url: URL
	try {
		url = new URL(connection?.URI ?? '')
	} catch {
		throw new LocalComputerSetupError('The selected Podman machine connection is invalid')
	}
	const expectedUser = inspected.Rootful ? 'root' : inspected.SSHConfig?.RemoteUsername
	const port = inspected.SSHConfig?.Port
	if (
		!connection?.IsMachine ||
		connection.ReadWrite !== true ||
		!connection.Identity ||
		win32.normalize(connection.Identity).toLowerCase() !==
			win32.normalize(realIdentity).toLowerCase() ||
		!Number.isSafeInteger(port) ||
		Number(port) < 1 ||
		Number(port) > 65535 ||
		url.protocol !== 'ssh:' ||
		url.hostname !== '127.0.0.1' ||
		Number(url.port) !== port ||
		!expectedUser ||
		url.username !== expectedUser ||
		url.password ||
		url.search ||
		url.hash ||
		(inspected.Rootful
			? url.pathname !== '/run/podman/podman.sock'
			: !/^\/run\/user\/\d+\/podman\/podman\.sock$/.test(url.pathname))
	)
		throw new LocalComputerSetupError(
			'The Podman connection must match the selected local WSL machine identity, port, user and socket; remote connections are refused',
		)
	await confirmLocalPipe(pipe, signal)
	const endpoint = `npipe:////./pipe/${machineName}`
	const run: LocalEngine['run'] = (args, call) => {
		const env = { ...process.env, ...call?.env }
		for (const name of [
			'CONTAINER_HOST',
			'CONTAINER_CONNECTION',
			'CONTAINER_SSHKEY',
			'DOCKER_HOST',
			'DOCKER_CONTEXT',
		])
			env[name] = undefined
		return runner.run(binary, ['--url', url.href, '--identity', realIdentity, ...args], {
			...call,
			env,
			cwd: realProfile,
		})
	}
	const info = JSON.parse(await run(['info', '--format', 'json'], { signal })) as {
		host?: { os?: string }
	}
	if (info.host?.os !== 'linux')
		throw new LocalComputerSetupError('The selected local Podman machine must run Linux containers')
	return {
		endpoint,
		run,
		async forwardPorts(ports, call) {
			const key = (
				await runner.run(
					win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'),
					[
						'--distribution',
						machineName,
						'--user',
						'root',
						'--exec',
						'cat',
						'/etc/ssh/ssh_host_ed25519_key.pub',
					],
					{ signal: call.signal, cwd: realProfile },
				)
			)
				.trim()
				.split(/\s+/)
				.slice(0, 2)
				.join(' ')
			return await startLocalSshForward({
				identity: realIdentity,
				port: Number(port),
				user: expectedUser,
				hostPublicKey: key,
				ports,
				...call,
			})
		},
	}
}
