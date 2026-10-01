import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile, rmdir } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalForwardCleanupError, startLocalSshForward } from '../ssh-forward.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	return { ...actual, rmdir: vi.fn(actual.rmdir) }
})
function fixture(options: { failStart?: boolean; failStop?: boolean } = {}) {
	const child = Object.assign(new EventEmitter(), {
		pid: 12345,
		exitCode: null,
		signalCode: null,
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
	child.kill.mockImplementation(() => {
		if (options.failStop) return false
		queueMicrotask(() => child.emit('close', 0))
		return true
	})
	vi.mocked(spawn).mockImplementation((_binary, args) => {
		queueMicrotask(() => {
			if (options.failStart) {
				child.emit('error', Error('Private key must not be exposed'))
				if (!options.failStop) child.emit('close', 1)
				return
			}
			for (const value of args as string[])
				if (/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/.test(value))
					child.stderr.write(
						`debug1: Local forwarding listening on 127.0.0.1 port ${value.split(':')[1]}.\r\n`,
					)
		})
		return child as unknown as ReturnType<typeof spawn>
	})
	const lost = vi.fn()
	const request = {
		identity: 'C:\\Users\\Operator\\machine-key',
		port: 61234,
		user: 'root',
		hostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAA=',
		ports: [41001, 41002],
		onLost: lost,
	}
	return { child, lost, request, options }
}
afterEach(() => vi.clearAllMocks())
describe('owned local machine forwarding', () => {
	it('pins host public key, machine identity and loopback listeners without reading user SSH config', async () => {
		const f = fixture()
		const forward = await startLocalSshForward(f.request)
		const [binary, args] = vi.mocked(spawn).mock.calls[0]!
		expect(binary).toContain('OpenSSH\\ssh.exe')
		expect(args).toContain('NUL')
		expect(args).toContain('StrictHostKeyChecking=yes')
		expect(args).toContain('ProxyCommand=none')
		expect(args).toContain(f.request.identity)
		const file = (args as string[])
			.find((x) => x.startsWith('UserKnownHostsFile='))!
			.slice('UserKnownHostsFile='.length)
		expect(await readFile(file, 'utf8')).toBe(`[127.0.0.1]:61234 ${f.request.hostPublicKey}\n`)
		expect(forward.ports).toHaveLength(2)
		forward.assertAlive()
		await forward.close()
		await forward.close()
		expect(f.child.kill).toHaveBeenCalledTimes(1)
		expect(f.lost).not.toHaveBeenCalled()
		expect(() => forward.assertAlive()).toThrow('ended')
		await expect(readFile(file)).rejects.toThrow()
	})
	it('keeps recovery ownership when helper stop fails, then confirms a retry', async () => {
		const f = fixture({ failStop: true })
		const forward = await startLocalSshForward(f.request)
		await expect(forward.close()).rejects.toThrow('could not be stopped')
		expect(() => forward.assertAlive()).toThrow('ended')
		f.options.failStop = false
		await forward.close()
		expect(f.child.kill).toHaveBeenCalledTimes(2)
	})
	it('notifies lease retirement when an admitted helper unexpectedly closes', async () => {
		const f = fixture()
		const forward = await startLocalSshForward(f.request)
		f.child.emit('close', 1)
		expect(f.lost).toHaveBeenCalledTimes(1)
		expect(() => forward.assertAlive()).toThrow('ended')
		await forward.close()
		expect(f.child.kill).not.toHaveBeenCalled()
	})
	it('refuses failed SSH startup without echoing credentials or private engine diagnostics', async () => {
		const f = fixture({ failStart: true })
		await expect(startLocalSshForward(f.request)).rejects.toThrow(
			'local machine SSH forwarding process failed',
		)
		expect(f.lost).not.toHaveBeenCalled()
	})
	it('refuses a malformed or injected host key before creating a helper', async () => {
		const f = fixture()
		await expect(
			startLocalSshForward({
				...f.request,
				hostPublicKey: 'ssh-ed25519 key\nmalicious-host another-key',
			}),
		).rejects.toThrow('public key')
		expect(spawn).not.toHaveBeenCalled()
	})
	it('retries partial temporary-file cleanup after the helper already stopped', async () => {
		const f = fixture()
		const forward = await startLocalSshForward(f.request)
		vi.mocked(rmdir).mockRejectedValueOnce(
			Object.assign(Error('Directory cleanup failed'), { code: 'EACCES' }),
		)
		await expect(forward.close()).rejects.toThrow('cleanup failed')
		await forward.close()
		expect(f.child.kill).toHaveBeenCalledTimes(1)
	})
	it('retains failed startup cleanup authority for a confirmed retry', async () => {
		const f = fixture({ failStart: true, failStop: true })
		let failure: LocalForwardCleanupError | undefined
		try {
			await startLocalSshForward(f.request)
		} catch (error) {
			expect(error).toBeInstanceOf(LocalForwardCleanupError)
			failure = error as LocalForwardCleanupError
		}
		expect(failure).toBeDefined()
		f.options.failStop = false
		await failure!.forward.close()
		expect(f.child.kill).toHaveBeenCalledTimes(2)
	})
	it('contains a failing host retirement callback during process-close dispatch', async () => {
		const f = fixture()
		const forward = await startLocalSshForward({
			...f.request,
			onLost() {
				throw Error('Host callback failed')
			},
		})
		expect(() => f.child.emit('close', 1)).not.toThrow()
		expect(() => forward.assertAlive()).toThrow('ended')
		await forward.close()
	})
})
