import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { describeProviderChain, providerChainCheck } from '../chain.js'
import { builtInDoctorChecks } from '../index.js'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-chain-'))
})

afterEach(() => {
	vi.unstubAllEnvs()
})

function writePrefs(body: unknown): void {
	mkdirSync(join(home, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'preferences.json'), JSON.stringify(body))
}

/**
 * Probes are skipped throughout: a real one reaches for localhost, which would
 * make the result depend on whatever happens to be listening on the machine
 * running the suite.
 */
function check(env: Record<string, string> = {}) {
	return describeProviderChain({ home, env, skipProbes: true })
}

describe('the provider chain check', () => {
	it('is inconclusive, not failing, when nothing is configured yet', async () => {
		const r = await check()
		expect(r.status).toBe('inconclusive')
		expect(r.message ?? '').toMatch(/no provider chain configured/)
	})

	it('prints every member in declared order, so the order is readable without the TUI', async () => {
		writePrefs({
			version: 3,
			providers: [{ id: 'anthropic' }, { id: 'openai', model: 'a-model' }],
		})
		const r = await check({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' })
		expect(r.status).toBe('pass')
		const message = r.message ?? ''
		const primaryAt = message.indexOf('primary')
		const fallbackAt = message.indexOf('fallback 1')
		expect(primaryAt).toBeGreaterThanOrEqual(0)
		// Order, not merely presence: members printed in an arbitrary order
		// would not answer the question this check exists for.
		expect(fallbackAt).toBeGreaterThan(primaryAt)
		expect(message).toContain('a-model')
	})

	it('shows the registry default for a member that pinned no model', async () => {
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }] })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.message ?? '').toContain('(default)')
	})

	it('WARNS when only a fallback is unusable — the primary still runs', async () => {
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.status).toBe('warn')
		expect(r.message ?? '').toContain('NO CREDENTIAL')
		expect(r.remediation ?? '').toMatch(/not a fallback/)
	})

	it('FAILS when the primary is unusable — no run can start', async () => {
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] })
		const r = await check({ OPENAI_API_KEY: 'y' })
		expect(r.status).toBe('fail')
	})

	it('says which member is bad when the chain itself is unusable', async () => {
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'not-a-provider' }] })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.status).toBe('fail')
		expect(r.message ?? '').toContain('fallback #1')
	})

	it('reports a lone provider as having no fallback', async () => {
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }] })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.status).toBe('pass')
		expect(r.message ?? '').toMatch(/no fallback/)
	})

	it('reads a v2 file as a one-member chain rather than refusing it', async () => {
		writePrefs({ version: 2, provider: 'anthropic' })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.status).toBe('pass')
		expect(r.message ?? '').toMatch(/no fallback/)
	})
})

describe('the check is reachable, not merely correct', () => {
	it('ships in builtInDoctorChecks, so `namzu doctor` actually runs it', () => {
		expect(builtInDoctorChecks.map((c) => c.id)).toContain('providers.chain')
	})

	it('passes the doctor context env through to discovery', async () => {
		// Drives `providerChainCheck.run`, not the helper: a helper proven in
		// isolation says nothing about whether the check reaches it, and a
		// `run` reading `process.env` instead of `ctx.env` would be invisible
		// to every case above.
		//
		// The credential is put ONLY on the context. `os.homedir()` reads
		// `HOME` on POSIX and `USERPROFILE` on Windows, so stubbing both points
		// the real code path at the temp home without mocking a module. If
		// `run` consulted `process.env`, it would find no key and report
		// `fail` — which is what makes the `pass` below mean something.
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }] })
		vi.stubEnv('HOME', home)
		vi.stubEnv('USERPROFILE', home)
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()

		const r = await providerChainCheck.run({
			cwd: process.cwd(),
			env: { ANTHROPIC_API_KEY: 'only-on-the-context' },
			projectRoot: null,
		})

		expect(r.status).toBe('pass')
	})
})
