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
	it('is skipped, not failing and not unanswered, when nothing is configured yet', async () => {
		// `skipped` rather than `inconclusive`: the check reached an answer, and
		// the answer is that there is no chain here. It used to say
		// `inconclusive`, which after the split means "could not answer" and now
		// carries exit 69 — so a machine with a key in the environment and no
		// preferences file, which is an ordinary working namzu, would have made
		// `namzu doctor` non-zero.
		const r = await check()
		expect(r.status).toBe('skipped')
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

	it('says WHOSE default a member that pinned no model gets', async () => {
		// `(namzu default)`, not `(default)`. The value is namzu's registry entry,
		// and a bare "default" reads as the provider's current one — which sends
		// an operator looking at the wrong place when the model is not what they
		// expected. Asserted as the whole phrase for that reason: `(default)`
		// alone is a substring of it and would pass either way.
		writePrefs({ version: 3, providers: [{ id: 'anthropic' }] })
		const r = await check({ ANTHROPIC_API_KEY: 'x' })
		expect(r.message ?? '').toContain('(namzu default)')
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

	/**
	 * The half this check could not see before.
	 *
	 * Every member below has a credential, so the older reading of this chain is
	 * `pass` — and a session would still be refused the moment the operator
	 * tried to start one, because the members declare different abilities.
	 * `doctor` exists to be asked on a calm day; a `pass` on a chain that cannot
	 * run is the worst answer it can give.
	 *
	 * The declarations are the drivers' real ones, not a fixture. A fixture
	 * would prove the sentence-builder works and say nothing about whether this
	 * check can reach a real declaration, which is the whole subject
	 * ("fixture must match production").
	 */
	describe('capability disagreements', () => {
		it('FAILS a chain whose members disagree, even though every credential is present', async () => {
			writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openrouter' }] })
			const r = await check({ ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y' })

			expect(r.status).toBe('fail')
			// Not a credential problem, and it must not read as one.
			expect(r.message ?? '').not.toContain('NO CREDENTIAL')
			expect(r.message ?? '').toMatch(/declare different capabilities/)
			expect(r.remediation ?? '').toMatch(/allowCapabilityMismatch/)
		})

		it('WARNS instead of failing once the operator has accepted the mismatch', async () => {
			writePrefs({
				version: 3,
				providers: [{ id: 'anthropic' }, { id: 'openrouter' }],
				allowCapabilityMismatch: true,
			})
			const r = await check({ ANTHROPIC_API_KEY: 'x', OPENROUTER_API_KEY: 'y' })

			// Named, not silenced: the limitation is real and the session prints it
			// on every launch, so a diagnostic that went quiet would disagree with
			// the thing it describes.
			expect(r.status).toBe('warn')
			expect(r.message ?? '').toMatch(/you have accepted that/)
		})

		it('still passes a chain whose members agree', async () => {
			writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] })
			const r = await check({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' })

			expect(r.status).toBe('pass')
			expect(r.message ?? '').not.toMatch(/declare different capabilities/)
		})

		/**
		 * A member with a registry entry and no wiring reads as unresolved rather
		 * than as agreement. That is issue #257 surfacing where an operator can
		 * see it: the entry, the label and the default model all advertise a
		 * provider that cannot be built.
		 */
		it('reports a member whose declaration cannot be read, without calling it a disagreement', async () => {
			writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'bedrock' }] })
			const r = await check({ ANTHROPIC_API_KEY: 'x', AWS_ACCESS_KEY_ID: 'y' })

			expect(r.status).toBe('warn')
			expect(r.message ?? '').toMatch(/Could not read what these members declare/)
			expect(r.message ?? '').not.toMatch(/declare different capabilities/)
		})

		/**
		 * This case used to assert that doctor reaches its `primaryUnreadable`
		 * branch for a provider with no bundled driver. It cannot any more, and
		 * the reason is the fix: such a primary is now refused when the
		 * preferences file is READ, so doctor answers from its `needs-repick`
		 * branch and never resolves capabilities at all.
		 *
		 * Rewritten to assert what is true rather than deleted, because the
		 * operator-visible property is unchanged and still worth pinning: doctor
		 * FAILS, and it points at the picker, which is the one screen that can
		 * fix it.
		 *
		 * `primaryUnreadable` is kept in the check and is not dead: `constructible`
		 * only promises that this build BUNDLES the driver, and a bundled import
		 * can still throw on a broken or partial install. That is a nameable
		 * input, which is what distinguishes a guard worth keeping from one that
		 * cannot fail ("a check that cannot fail").
		 */
		it('FAILS a primary with no bundled driver, and sends the operator to the picker', async () => {
			writePrefs({ version: 3, providers: [{ id: 'bedrock' }, { id: 'anthropic' }] })
			const r = await check({ AWS_ACCESS_KEY_ID: 'y', ANTHROPIC_API_KEY: 'x' })

			expect(r.status).toBe('fail')
			expect(r.message ?? '').toMatch(/not available in this build/)
			expect(r.remediation ?? '').toMatch(/pick again/)
		})

		it('does NOT refuse the file over an unbuildable FALLBACK — the primary still runs', async () => {
			// The asymmetry, read from the outside. A spare namzu cannot build is
			// dropped with a notice; taking the whole session away over it would be
			// the opposite trade.
			writePrefs({ version: 3, providers: [{ id: 'anthropic' }, { id: 'bedrock' }] })
			const r = await check({ ANTHROPIC_API_KEY: 'x', AWS_ACCESS_KEY_ID: 'y' })

			expect(r.status).toBe('warn')
			expect(r.message ?? '').toMatch(/Could not read what these members declare/)
		})
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
		vi.stubEnv('NAMZU_HOME', '')
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()

		const r = await providerChainCheck.run({
			cwd: process.cwd(),
			env: { ANTHROPIC_API_KEY: 'only-on-the-context' },
			projectRoot: null,
		})

		expect(r.status).toBe('pass')
	})

	it('reads the production preferences from NAMZU_HOME instead of forcing the OS-home default', async () => {
		const appHome = join(home, 'application-state')
		mkdirSync(appHome, { recursive: true })
		writeFileSync(
			join(appHome, 'preferences.json'),
			JSON.stringify({ version: 3, providers: [{ id: 'anthropic' }] }),
		)
		// Keep the OS home pointed somewhere with no `.namzu/preferences.json`.
		// The old check passed `homedir()` explicitly and therefore reported this
		// as skipped even though every other production surface saw NAMZU_HOME.
		vi.stubEnv('HOME', home)
		vi.stubEnv('USERPROFILE', home)
		vi.stubEnv('NAMZU_HOME', appHome)

		const result = await providerChainCheck.run({
			cwd: process.cwd(),
			env: { ANTHROPIC_API_KEY: 'only-on-the-doctor-context' },
			projectRoot: null,
		})

		expect(result.status).toBe('pass')
		expect(result.message ?? '').toContain('1 provider configured')
	})
})
