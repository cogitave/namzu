/**
 * Turn the dependencies a model described into the step ids a plan uses.
 *
 * The model is shown `depends_on: string[]` on every plan step, described to
 * it as "Step descriptions this depends on" — descriptions, because that is
 * the only handle it has. Step ids are minted at execute time (`step_1`,
 * `step_2`, ...), so the model cannot name one and should not be asked to.
 *
 * The translation between the two was never written. `approve_plan` passed
 * `dependsOn: []` for every step, so whatever ordering the model declared
 * was dropped at the one place it entered the system. The visible cost is
 * not scheduling — `PlanManager.getNextPendingStep` holds the dependency
 * gate and currently has no callers — it is the APPROVAL: `dependsOn` is
 * serialized into the `plan_approval` payload a human reads before saying
 * yes, so a reviewer was shown a plan whose steps all looked independent
 * however carefully the model had ordered them.
 */

/** What the model said, before ids exist. */
export interface DescribedStep {
	readonly description: string
	readonly depends_on?: readonly string[]
}

export type ResolvedDependencies =
	| { readonly ok: true; readonly dependsOn: readonly (readonly string[])[] }
	| { readonly ok: false; readonly error: string }

/**
 * Resolve every step's declared dependencies to step ids, or refuse.
 *
 * Returns one id array per input step, positionally.
 *
 * **Refusing beats dropping.** Every failure here means the model expressed
 * an ordering it cannot have and the plan does not mean what it says; the
 * old behaviour — discard silently — is what put an empty dependency list in
 * front of a human approver. The error text names the offending description
 * so the model can correct it and call again, which is the same shape every
 * other recoverable tool failure in this kernel uses.
 */
export function resolvePlanDependencies(
	steps: readonly DescribedStep[],
	idOf: (index: number) => string,
): ResolvedDependencies {
	const byDescription = new Map<string, number[]>()
	for (let i = 0; i < steps.length; i++) {
		const description = steps[i]?.description
		if (description === undefined) continue
		const key = normalize(description)
		const at = byDescription.get(key)
		if (at) at.push(i)
		else byDescription.set(key, [i])
	}

	const resolved: string[][] = []

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]
		const declared = step?.depends_on
		if (!step || !declared || declared.length === 0) {
			resolved.push([])
			continue
		}

		const ids: string[] = []
		const seen = new Set<number>()

		for (const wanted of declared) {
			const matches = byDescription.get(normalize(wanted))

			if (!matches) {
				return {
					ok: false,
					error: `Step ${i + 1} depends on "${wanted}", which is not the description of any step in this plan. A dependency has to name another step exactly. Fix the description or drop the dependency, then call approve_plan again.`,
				}
			}

			// Two steps sharing a description make "depends on that one"
			// unanswerable. Picking either is a coin flip whose result a human
			// then approves as if it were the model's intent.
			if (matches.length > 1) {
				return {
					ok: false,
					error: `Step ${i + 1} depends on "${wanted}", but ${matches.length} steps share that description, so it does not identify one. Make the descriptions distinct, then call approve_plan again.`,
				}
			}

			const target = matches[0] as number

			if (target === i) {
				return {
					ok: false,
					error: `Step ${i + 1} depends on itself. A step cannot wait for its own completion; remove the dependency and call approve_plan again.`,
				}
			}

			// Duplicates in one step's list are harmless — same edge twice.
			if (seen.has(target)) continue
			seen.add(target)
			ids.push(idOf(target))
		}

		resolved.push(ids)
	}

	// A cycle is the failure worth catching hardest. Every step in one waits
	// for another that is waiting for it, so the dependency gate never
	// releases any of them and a plan that reads as fine simply stops. There
	// is no error to observe at that point — the run just makes no progress.
	const cycle = findCycle(resolved, (index) => idOf(index))
	if (cycle) {
		return {
			ok: false,
			error: `These steps depend on each other in a loop: ${cycle.map((i) => `step ${i + 1} ("${steps[i]?.description ?? ''}")`).join(' -> ')}. No step in a loop can ever start, because each waits for another that is waiting for it. Break the loop and call approve_plan again.`,
		}
	}

	return { ok: true, dependsOn: resolved }
}

/**
 * Descriptions come from a model, so they carry incidental whitespace and
 * casing differences between the step and the reference to it. Matching on
 * the exact string would reject "Run the tests" against "run the tests " —
 * a refusal the model cannot learn anything from, for a plan that was right.
 */
function normalize(description: string): string {
	return description.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Indices forming a dependency cycle, in order, or undefined. */
function findCycle(
	dependsOn: readonly (readonly string[])[],
	idOf: (index: number) => string,
): number[] | undefined {
	const indexOfId = new Map<string, number>()
	for (let i = 0; i < dependsOn.length; i++) indexOfId.set(idOf(i), i)

	const UNVISITED = 0
	const ON_STACK = 1
	const DONE = 2
	const state = new Array<number>(dependsOn.length).fill(UNVISITED)
	const stack: number[] = []

	const walk = (node: number): number[] | undefined => {
		state[node] = ON_STACK
		stack.push(node)

		for (const depId of dependsOn[node] ?? []) {
			const next = indexOfId.get(depId)
			if (next === undefined) continue
			if (state[next] === ON_STACK) {
				// Report the loop itself, not the path that reached it.
				const from = stack.indexOf(next)
				return [...stack.slice(from), next]
			}
			if (state[next] === UNVISITED) {
				const found = walk(next)
				if (found) return found
			}
		}

		stack.pop()
		state[node] = DONE
		return undefined
	}

	for (let i = 0; i < dependsOn.length; i++) {
		if (state[i] !== UNVISITED) continue
		const found = walk(i)
		if (found) return found
	}

	return undefined
}
