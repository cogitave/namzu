import type { DoctorCheck, DoctorCheckResult, InvariantRegistry } from '@namzu/sdk'
import { invariants } from '@namzu/sdk'

interface InvariantRow {
	readonly id: string
	readonly outcome: Awaited<ReturnType<InvariantRegistry['evaluate']>>
	readonly violations: number
}

function label(row: InvariantRow): string {
	return `${row.id} (${row.violations} violation${row.violations === 1 ? '' : 's'})`
}

/**
 * Evaluate every invariant `registry` holds and fold the outcomes, plus each
 * invariant's own violation counter, into one doctor row.
 *
 * Exported separately from the `DoctorCheck` — same reasoning as
 * `describeInstalledPackage` on the telemetry check — so a test can drive a
 * SCOPED registry directly, rather than mutating the process-wide singleton
 * every other test also reads. The check itself is still exercised through
 * `invariantsCheck.run`, because a helper proven in isolation says nothing
 * about whether the check reaches it.
 *
 * Every invariant is evaluated with `ctx: undefined`. `namzu doctor` runs
 * with no live run and no candidate compaction reduction — there is nothing
 * a real invariant's check could read that is specific to one run — so
 * `undefined` is the honest context, not a shortcut: each check registered
 * against it is written to answer `unknown` rather than guess (see
 * `compaction.ts` and `claim-disk.ts` in `@namzu/sdk`), and this row reports
 * that state rather than papering over it as a pass.
 */
export async function describeInvariants(registry: InvariantRegistry): Promise<DoctorCheckResult> {
	const ids = registry.listIds()
	if (ids.length === 0) {
		return { status: 'skipped', message: 'no invariants registered' }
	}

	const rows: InvariantRow[] = await Promise.all(
		ids.map(async (id) => ({
			id,
			outcome: await registry.evaluate(id, undefined),
			violations: registry.violationCount(id),
		})),
	)

	const violated = rows.filter((r) => r.outcome.state === 'violated')
	const unknown = rows.filter((r) => r.outcome.state === 'unknown')

	if (violated.length > 0) {
		const detail = violated
			.map((r) => (r.outcome.state === 'violated' ? `${label(r)}: ${r.outcome.detail}` : label(r)))
			.join('; ')
		return {
			status: 'fail',
			message: `${violated.length}/${ids.length} invariant(s) violated — ${detail}`,
			remediation:
				'Check the warn/error logs at the module that registered the violated invariant.',
		}
	}

	if (unknown.length > 0) {
		const names = unknown.map(label).join(', ')
		// `skipped`, not `inconclusive`, and the difference is the whole
		// behaviour of this row. `inconclusive` maps to exit 69 in
		// `doctor/registry.ts` and means "I asked and could not establish an
		// answer" — a real signal that something is wrong with the check
		// itself. A runtime invariant outside a live run is a different thing:
		// the question has no subject yet, every registered check is written
		// to answer `unknown` here on purpose, and so this state is reached on
		// EVERY doctor run. Reporting it as inconclusive made `namzu doctor`
		// exit 69 unconditionally, which retires the one code that was
		// supposed to mean something.
		//
		// `skipped` is not "satisfied" either — the summary counts it
		// separately from `pass`, and the message still names which invariants
		// went unevaluated and how many violations each has accumulated. The
		// violation counters above are what actually carry a live run's
		// findings back to this row.
		return {
			status: 'skipped',
			message: `${unknown.length}/${ids.length} invariant(s) have no subject outside a live run: ${names}`,
		}
	}

	return {
		status: 'pass',
		message: `${ids.length} invariant(s) hold: ${rows.map(label).join(', ')}`,
	}
}

export const invariantsCheck: DoctorCheck = {
	id: 'runtime.invariants',
	category: 'runtime',
	run: (): Promise<DoctorCheckResult> => describeInvariants(invariants),
}
