import { describe, expect, it, vi } from 'vitest'

import { resolveSandbox, sandboxRequested, sandboxResolvedSeverity } from '../sandbox.js'

/**
 * The CLI runs tools on the host under the permission system by default, and
 * the OS sandbox is the opt-in. It was on by default for a while; on a machine
 * where it binds only the working directory and cuts the network, a coding
 * agent could not read a file the user named, reach a registry or run a host
 * tool, so the default moved back — see the note at the top of `sandbox.ts`.
 *
 * These tests are about which way the default falls and whether an
 * operator can find out what they actually got — not about what any one
 * platform enforces, which is a property of the machine running them.
 */

function stubLogger(): never {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	} as never
}

describe('the sandbox for a turn', () => {
	it('is off when nothing is configured, and says how to turn it on', () => {
		const resolved = resolveSandbox(stubLogger(), undefined)

		expect(resolved.provider).toBeUndefined()
		expect(resolved.unconfined).toBe(true)
		expect(resolved.workspace).toBe('host')
		expect(resolved.notice).toMatch(/the default/)
		expect(resolved.notice).toContain('sandbox.enabled: true')
		// Host execution is not unreviewed execution, and the notice says so.
		expect(resolved.notice).toMatch(/permission prompts/)
	})

	it('is on when the operator turns it on', () => {
		const resolved = resolveSandbox(stubLogger(), { enabled: true })

		expect(resolved.provider).toBeDefined()
		expect(resolved.workspace).toBe('working-directory')
		expect(resolved.notice).toMatch(/persist across turns/i)
	})

	it('is off when turned off explicitly, and says it was the configuration', () => {
		const resolved = resolveSandbox(stubLogger(), { enabled: false })

		expect(resolved.provider).toBeUndefined()
		expect(resolved.unconfined).toBe(true)
		expect(resolved.notice).toMatch(/off by configuration/)
		expect(resolved.notice).toContain('sandbox.enabled')
		expect(resolved.workspace).toBe('host')
	})

	it('is requested by a named requirement or a disposable workspace, never dropped silently', () => {
		// Pure, so it is asserted on every machine: resolving a requirement
		// this machine cannot meet would throw, which is a different test.
		expect(sandboxRequested(undefined)).toBe(false)
		expect(sandboxRequested({ requireIsolation: [] })).toBe(false)
		expect(sandboxRequested({ requireIsolation: ['network'] })).toBe(true)
		expect(sandboxRequested({ workspace: 'ephemeral' })).toBe(true)
		expect(sandboxRequested({ workspace: 'working-directory' })).toBe(false)
		// An explicit switch wins over what the other keys imply.
		expect(sandboxRequested({ enabled: false, requireIsolation: ['network'] })).toBe(false)
		expect(sandboxRequested({ enabled: true })).toBe(true)
	})

	it('names an explicit disposable workspace honestly', () => {
		const resolved = resolveSandbox(stubLogger(), { workspace: 'ephemeral' })

		expect(resolved.workspace).toBe('ephemeral')
		expect(resolved.notice).toMatch(/removed at teardown/i)
	})

	it('always produces a notice, including when it is on', () => {
		// Silence on the happy path is how "isolated" becomes an assumption
		// rather than something the operator was told.
		const on = resolveSandbox(stubLogger(), { enabled: true })
		const off = resolveSandbox(stubLogger(), undefined)

		expect(on.notice.length).toBeGreaterThan(0)
		expect(off.notice.length).toBeGreaterThan(0)
	})

	it('reports unconfined honestly when the platform enforces nothing', () => {
		// A sandbox that confines nothing is not the same as no sandbox, and
		// is emphatically not protection. Whichever this machine is, the two
		// fields have to agree — a notice saying "not confined" beside
		// `unconfined: false` would be the surface lying about its own state.
		const resolved = resolveSandbox(stubLogger(), { enabled: true })

		if (resolved.unconfined) {
			expect(resolved.notice).toMatch(/not confined/i)
		} else {
			expect(resolved.notice).toMatch(/enforcing/i)
		}
	})

	it('refuses to start when a required control cannot be enforced here', () => {
		// The one case that throws. An operator who names a control is
		// asking a question, and starting anyway would answer it with
		// something other than the truth.
		//
		// Skipped rather than asserted when this machine happens to enforce
		// everything: a test that passes because the platform is generous
		// proves nothing about the refusal.
		const probe = resolveSandbox(stubLogger(), { enabled: true })
		if (!probe.unconfined && !probe.notice.includes('NOT enforcing')) return

		expect(() =>
			resolveSandbox(stubLogger(), { requireIsolation: ['filesystem', 'network', 'process'] }),
		).toThrow()
	})
})

describe('the sandbox-resolved boot record', () => {
	// Deliberately NOT routed through `resolveSandbox` + a real
	// `LocalSandboxProvider` — the platform this test runs on decides
	// `unconfined`, and CI's platform is not every reader's. Testing the
	// pure mapping directly is what makes both branches assertable on every
	// machine, matching this file's own stated philosophy above.

	it('is warn when the platform confines nothing', () => {
		expect(
			sandboxResolvedSeverity({
				unconfined: true,
				enforced: [],
				required: [],
				notice: 'sandbox off',
			}),
		).toBe('warn')
	})

	it('is info when the platform confines something', () => {
		expect(
			sandboxResolvedSeverity({
				unconfined: false,
				enforced: [],
				required: [],
				notice: 'sandbox on',
			}),
		).toBe('info')
	})

	it('agrees with a fully-enforcing ResolvedSandbox, not only a hand-built stub', () => {
		// One assertion tying the pure mapping back to whatever THIS machine's
		// resolveSandbox actually returns, so the two cannot silently diverge
		// in meaning even though they are tested independently above.
		const resolved = resolveSandbox(stubLogger(), { enabled: true })
		expect(sandboxResolvedSeverity(resolved)).toBe(resolved.unconfined ? 'warn' : 'info')
	})
})
