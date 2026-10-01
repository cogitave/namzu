import { spawn } from 'node:child_process'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import type { LocalPortForward } from './engine.js'

/** Internal retained authority for retrying an unconfirmed owned startup cleanup. */
export class LocalForwardCleanupError extends Error {
	constructor(
		readonly forward: LocalPortForward,
		cause: unknown,
	) {
		super('The owned local computer forward requires cleanup recovery', { cause })
	}
}

async function removeIfPresent(
	path: string,
	remove: (path: string) => Promise<void>,
): Promise<void> {
	try {
		await remove(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}

interface LocalSshForwardOptions {
	readonly identity: string
	readonly port: number
	readonly user: string
	readonly hostPublicKey: string
	readonly ports: readonly number[]
	readonly signal?: AbortSignal
	readonly onLost: () => void
}

async function reservePort(): Promise<number> {
	const server = createServer()
	return await new Promise<number>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			server.close((error) => {
				if (error) reject(error)
				else if (!address || typeof address === 'string')
					reject(new Error('No local forwarding port'))
				else resolve(address.port)
			})
		})
	})
}

/** An owned loopback tunnel to an already verified local WSL machine only. */
export async function startLocalSshForward(
	options: LocalSshForwardOptions,
): Promise<LocalPortForward> {
	options.signal?.throwIfAborted()
	if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(options.hostPublicKey))
		throw new Error('The registered local machine did not provide its SSH host public key')
	const ports = await Promise.all(options.ports.map(() => reservePort()))
	const directory = await mkdtemp(join(tmpdir(), 'namzu-pal-forward-'))
	const knownHosts = join(directory, 'known_hosts')
	await writeFile(knownHosts, `[127.0.0.1]:${options.port} ${options.hostPublicKey}\n`, {
		mode: 0o600,
		flag: 'wx',
	})
	const child = spawn(
		win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
		[
			'-N',
			'-T',
			'-v',
			'-F',
			'NUL',
			'-o',
			'BatchMode=yes',
			'-o',
			'ExitOnForwardFailure=yes',
			'-o',
			'StrictHostKeyChecking=yes',
			'-o',
			`UserKnownHostsFile=${knownHosts}`,
			'-o',
			'HostKeyAlgorithms=ssh-ed25519',
			'-o',
			'IdentitiesOnly=yes',
			'-o',
			'ProxyCommand=none',
			'-o',
			'ProxyJump=none',
			'-i',
			options.identity,
			'-p',
			String(options.port),
			...ports.flatMap((port, index) => [
				'-L',
				`127.0.0.1:${port}:127.0.0.1:${options.ports[index]}`,
			]),
			`${options.user}@127.0.0.1`,
		],
		{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
	)
	let ended = false
	let closing = false
	let ready = false
	let cleanup: Promise<void> | undefined
	const closed = new Promise<void>((resolve) => {
		child.once('close', () => {
			ended = true
			if (ready && !closing) {
				try {
					options.onLost()
				} catch {
					// A host callback must not crash the process-close event dispatch.
					// The ended handle remains fenced and close() retains recovery.
				}
			}
			resolve()
		})
	})
	const close = (): Promise<void> => {
		if (cleanup) return cleanup
		closing = true
		cleanup = (async () => {
			if (
				!ended &&
				child.pid !== undefined &&
				child.exitCode === null &&
				child.signalCode === null &&
				!child.kill()
			)
				throw new Error('The owned local computer forwarding process could not be stopped')
			await closed
			await removeIfPresent(knownHosts, unlink)
			await removeIfPresent(directory, rmdir)
		})().catch((error: unknown) => {
			cleanup = undefined
			throw error
		})
		return cleanup
	}
	const forward: LocalPortForward = {
		ports,
		assertAlive() {
			if (ended || closing) throw new Error('The local computer forwarding process has ended')
		},
		close,
	}
	try {
		await new Promise<void>((resolve, reject) => {
			let diagnostic = ''
			const opened = new Set<number>()
			const detach = () => {
				options.signal?.removeEventListener('abort', abort)
				child.stderr.removeListener('data', data)
				child.removeListener('close', fail)
			}
			const abort = () => {
				detach()
				reject(options.signal?.reason)
			}
			const fail = () => {
				detach()
				reject(new Error('The verified local machine SSH forwarding process failed'))
			}
			const data = (chunk: Buffer) => {
				diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16_384)
				for (const port of ports)
					if (diagnostic.includes(`Local forwarding listening on 127.0.0.1 port ${port}.`))
						opened.add(port)
				if (opened.size === ports.length) {
					ready = true
					detach()
					resolve()
				}
			}
			child.stderr.on('data', data)
			child.once('error', fail)
			child.once('close', fail)
			options.signal?.addEventListener('abort', abort, { once: true })
			if (options.signal?.aborted) abort()
		}).finally(() => child.stderr.resume())
		options.signal?.throwIfAborted()
		return forward
	} catch (error) {
		try {
			await close()
		} catch {
			throw new LocalForwardCleanupError(forward, error)
		}
		throw error
	}
}
