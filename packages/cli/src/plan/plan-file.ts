import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { ToolCallSummary } from '@namzu/sdk'

/**
 * The file plan mode may write.
 *
 * One plan file is kept per session, named by a session
 * slug, in a plans directory under the config home. Here the session already
 * has a directory of its own, so the file is `plans/plan.md` inside it
 * (`SessionPaths.planFile`): `~/.namzu/projects/<slug>/<session-id>/plans/plan.md`.
 * There is no separate plans-directory setting.
 */

/** The tools that write a file, and the input key naming it. */
const WRITERS = new Set(['write', 'edit'])

/**
 * Whether a call is a write of exactly the plan file. Paths compare after
 * resolving against the working directory, so `../../.namzu/…` spellings of
 * the same file match and a prefix or a sibling does not.
 */
export function isPlanFileWrite(planPath: string, cwd: string) {
	const target = resolve(planPath)
	return (call: Pick<ToolCallSummary, 'name' | 'input'>): boolean => {
		if (!WRITERS.has(call.name)) return false
		const input = call.input
		if (input === null || typeof input !== 'object') return false
		const path = (input as { path?: unknown }).path
		if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return false
		return resolve(isAbsolute(path) ? path : resolve(cwd, path)) === target
	}
}

/** The plan as written, or `undefined` when the file is missing or blank. */
export async function readPlan(planPath: string): Promise<string | undefined> {
	try {
		const text = await readFile(planPath, 'utf8')
		return text.trim().length > 0 ? text : undefined
	} catch {
		return undefined
	}
}

/** The most of the plan carried across a compaction, in characters (about 5,000 tokens). */
export const MAX_CARRIED_PLAN_CHARS = 20_000

/**
 * What a compaction carries of the plan: where the file is and what it says
 * now, so the work in progress can keep following it. `undefined` when no plan
 * has been written.
 */
export async function planCarriedAcrossCompaction(planPath: string): Promise<string | undefined> {
	const plan = await readPlan(planPath)
	if (plan === undefined) return undefined
	const text =
		plan.length > MAX_CARRIED_PLAN_CHARS
			? `${plan.slice(0, MAX_CARRIED_PLAN_CHARS)}\n… [the rest of the plan is in the file]`
			: plan
	return [
		'### Plan file',
		'',
		`A plan from plan mode is saved at ${planPath}. Its current text:`,
		'',
		text.trimEnd(),
		'',
		'If this plan is relevant to the work in progress, keep following it.',
	].join('\n')
}
