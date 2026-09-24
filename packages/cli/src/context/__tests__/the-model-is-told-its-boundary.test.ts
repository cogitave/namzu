/**
 * The model's boundary, stated before it meets it.
 *
 * It used to learn where its tools stopped from refusal strings, and read a
 * path outside the working directory as a wall on a machine where it was a
 * question. These pin what each configuration says: where the tools run,
 * what they reach, and the one way past the edge that configuration offers.
 */

import { describe, expect, it } from 'vitest'

import {
	type EnvironmentFacts,
	type ExecutionBoundary,
	composeEnvironmentPrompt,
	detectWsl,
} from '../environment.js'

const base: EnvironmentFacts = { today: '2026-09-22', branch: 'main', isRepository: true }

function promptFor(boundary: ExecutionBoundary, wsl?: EnvironmentFacts['wsl']): string {
	return composeEnvironmentPrompt({ ...base, boundary, ...(wsl ? { wsl } : {}) })
}

describe('on the host', () => {
	it('says a path outside the working directory is asked about, not refused', () => {
		const text = promptFor({ escape: 'ask', interactive: true })
		expect(text).toMatch(/not in a sandbox/)
		expect(text).toMatch(
			/A path anywhere else is not refused outright: the user is asked to approve that call first, every time/,
		)
		expect(text).toContain('/add-dir <path>')
		// Nothing to escape on the host, so the escape is not offered.
		expect(text).not.toContain('dangerously_disable_sandbox')
	})

	it('says a path outside is refused when nobody is at the terminal, and how to get it added', () => {
		const text = promptFor({ escape: 'refused', interactive: false })
		expect(text).toMatch(/A path anywhere else is refused in this session/)
		expect(text).toContain('--add-dir <path>')
		expect(text).not.toMatch(/the user is asked/)
	})
})

describe('in the sandbox', () => {
	const sandbox = { environment: 'linux-bwrap', enforced: ['filesystem', 'network', 'process'] }

	it('names what it enforces and offers the per-command escape when a person can approve it', () => {
		const text = promptFor({ sandbox, escape: 'ask', interactive: true })
		expect(text).toContain('linux-bwrap, enforcing filesystem, network, process')
		expect(text).toMatch(/The network is cut inside it/)
		expect(text).toContain('`dangerously_disable_sandbox: true`')
		expect(text).toMatch(/asked to approve it every time, whatever else is approved/)
		expect(text).toMatch(/plan and strict permission modes refuse it/)
	})

	it('says what a file-system-confining sandbox still shows, without claiming nothing else exists', () => {
		const text = promptFor({ sandbox, escape: 'ask', interactive: true })
		expect(text).toMatch(/system directories programs need are readable, \/tmp is private/)
		expect(text).not.toMatch(/nothing else exists inside it/)
	})

	it('does not claim to hide the file system where the sandbox does not confine it', () => {
		for (const unconfined of [
			{ environment: 'linux-namespace', enforced: ['network', 'process'] },
			{ environment: 'basic', enforced: [] },
		]) {
			const text = promptFor({ sandbox: unconfined, escape: 'ask', interactive: true })
			expect(text).toMatch(/does not confine the file system here/)
			expect(text).not.toMatch(/cannot be reached from it/)
		}
		expect(
			promptFor({
				sandbox: { environment: 'basic', enforced: [] },
				escape: 'ask',
				interactive: true,
			}),
		).toContain('enforcing nothing on this platform')
	})

	it('offers no escape when escapes are refused', () => {
		const text = promptFor({ sandbox, escape: 'refused', interactive: false })
		expect(text).not.toContain('dangerously_disable_sandbox')
		expect(text).toMatch(/cannot leave the sandbox in this session/)
	})
})

describe('WSL', () => {
	it('is detected from WSL_DISTRO_NAME, with interop from WSL_INTEROP', () => {
		const wsl = detectWsl(
			{ WSL_DISTRO_NAME: 'archlinux', WSL_INTEROP: '/run/WSL/240_interop' },
			{ exists: () => false, list: () => ['c', 'd', 'wsl', 'wslg'] },
		)
		expect(wsl).toEqual({ distro: 'archlinux', interop: true, drives: ['/mnt/c', '/mnt/d'] })
	})

	it('counts interop as on when its binfmt handler is registered without the variable', () => {
		const wsl = detectWsl(
			{ WSL_DISTRO_NAME: 'Ubuntu' },
			{
				exists: (path) => path === '/proc/sys/fs/binfmt_misc/WSLInterop',
				list: () => [],
			},
		)
		expect(wsl).toEqual({ distro: 'Ubuntu', interop: true, drives: [] })
	})

	it('is detected from WSL_INTEROP alone, and reports interop off when nothing says it is on', () => {
		expect(detectWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, { list: () => [] })).toEqual({
			distro: null,
			interop: true,
			drives: [],
		})
		expect(
			detectWsl({ WSL_DISTRO_NAME: 'Debian' }, { exists: () => false, list: () => [] })?.interop,
		).toBe(false)
	})

	it('says nothing about Windows programs outside WSL', () => {
		expect(promptFor({ escape: 'ask', interactive: true })).not.toMatch(/explorer\.exe|powershell/)
	})

	it('is absent on a Linux that is not WSL', () => {
		expect(detectWsl({ HOME: '/home/me' }, { exists: () => true, list: () => ['c'] })).toBe(
			undefined,
		)
	})

	it('tells a host session where the Windows drives are and how to start a Windows program', () => {
		const text = promptFor(
			{ escape: 'ask', interactive: true },
			{ distro: 'archlinux', interop: true, drives: ['/mnt/c'] },
		)
		expect(text).toContain('Windows Subsystem for Linux (distro `archlinux`)')
		expect(text).toContain('`/mnt/c`')
		expect(text).toMatch(/asks for approval first/)
		expect(text).toContain('powershell.exe -NoProfile -Command')
		expect(text).toContain('cmd.exe /c')
		// Observed: explorer.exe opened the page, exited 1, and the model
		// reported failure.
		expect(text).toContain('`explorer.exe .` (it exits 1 even when it succeeds)')
	})

	it('tells a sandboxed session the drives and Windows programs need the escape', () => {
		const text = promptFor(
			{
				sandbox: { environment: 'linux-bwrap', enforced: ['filesystem'] },
				escape: 'ask',
				interactive: true,
			},
			{ distro: 'archlinux', interop: true, drives: ['/mnt/c'] },
		)
		expect(text).toMatch(
			/outside the sandbox, so a command there needs `\/add-dir` or the sandbox escape/,
		)
		expect(text).toMatch(/running one needs the sandbox escape/)
	})

	it('does not say the drives are hidden by a sandbox that leaves the file system visible', () => {
		const text = promptFor(
			{
				sandbox: { environment: 'linux-namespace', enforced: ['network', 'process'] },
				escape: 'ask',
				interactive: true,
			},
			{ distro: 'archlinux', interop: true, drives: ['/mnt/c'] },
		)
		expect(text).not.toMatch(/outside the sandbox, so a command there/)
		expect(text).not.toMatch(/does not mount the Windows drives/)
		expect(text).toMatch(/the file tools reach them only once added with `\/add-dir`/)
	})

	it('tells a headless host session a file tool reaching the drives is refused', () => {
		const text = promptFor(
			{ escape: 'refused', interactive: false },
			{ distro: 'archlinux', interop: true, drives: ['/mnt/c'] },
		)
		expect(text).toMatch(/a file tool reaching them is refused in this session/)
	})

	it('says interop is off rather than suggesting programs that will not start', () => {
		const text = promptFor(
			{ escape: 'ask', interactive: true },
			{ distro: 'archlinux', interop: false, drives: ['/mnt/c'] },
		)
		expect(text).toMatch(/interop is off here/)
		expect(text).not.toContain('powershell.exe')
		expect(text).not.toContain('explorer.exe')
	})
})
