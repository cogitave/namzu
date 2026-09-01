import { describe, expect, it, vi } from 'vitest'

import { resolveSandbox, sandboxResolvedSeverity } from '../sandbox.js'

/**
 * `sandboxProvider` appeared zero times in this package, so
 * `context.sandbox` was always undefined and every command ran in the host
 * process with the host environment. The docs described isolation that
 * held on no path.
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

describe('the sandbox for a run', () => {
	it('is on when nothing is configured', () => {
		// The whole point. Absent used to mean off, and not by decision.
		const resolved = resolveSandbox(stubLogger(), undefined)

		expect(resolved.provider).toBeDefined()
		expect(resolved.workspace).toBe('working-directory')
		expect(resolved.notice).toMatch(/persist across turns/i)
	})

	it('is on when the config names only an isolation requirement', () => {
		const resolved = resolveSandbox(stubLogger(), { requireIsolation: [] })

		expect(resolved.provider).toBeDefined()
	})

	it('is off only when the operator says so, and says why it is off', () => {
		const resolved = resolveSandbox(stubLogger(), { enabled: false })

		expect(resolved.provider).toBeUndefined()
		expect(resolved.unconfined).toBe(true)
		// A refusal a reader cannot act on is a dead end. The notice names
		// the setting to change.
		expect(resolved.notice).toContain('sandbox.enabled')
		expect(resolved.workspace).toBe('host')
	})

	it('names an explicit disposable workspace honestly', () => {
		const resolved = resolveSandbox(stubLogger(), { workspace: 'ephemeral' })

		expect(resolved.workspace).toBe('ephemeral')
		expect(resolved.notice).toMatch(/removed at teardown/i)
	})

	it('always produces a notice, including when it is on', () => {
		// Silence on the happy path is how "isolated" becomes an assumption
		// rather than something the operator was told.
		const on = resolveSandbox(stubLogger(), undefined)
		const off = resolveSandbox(stubLogger(), { enabled: false })

		expect(on.notice.length).toBeGreaterThan(0)
		expect(off.notice.length).toBeGreaterThan(0)
	})

	it('reports unconfined honestly when the platform enforces nothing', () => {
		// A sandbox that confines nothing is not the same as no sandbox, and
		// is emphatically not protection. Whichever this machine is, the two
		// fields have to agree — a notice saying "not confined" beside
		// `unconfined: false` would be the surface lying about its own state.
		const resolved = resolveSandbox(stubLogger(), undefined)

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
		const probe = resolveSandbox(stubLogger(), undefined)
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
		const resolved = resolveSandbox(stubLogger(), undefined)
		expect(sandboxResolvedSeverity(resolved)).toBe(resolved.unconfined ? 'warn' : 'info')
	})
})
