/**
 * A positive whole number of milliseconds from the environment, or the
 * caller's own default.
 *
 * Every bound that can be tuned wants the same three answers, and the third
 * is the one worth sharing: a variable set to `soon`, to `-1` or to nothing
 * at all falls back rather than parsing, because a turn must not wait, hold or
 * time out for `NaN`.
 *
 * `process.env` is read on every call, so where it is called decides when the
 * value is sampled — `wait_for_job` fixes its bounds at module load and names
 * them in a tool schema, and the kernel's hold ceiling asks per hold. That
 * choice is why this lives here rather than being imported from the tool: the
 * kernel reaching into `wait_for_job` for the parse would pull the tool's
 * module-load sampling into the runtime's own graph, and move when the
 * `NAMZU_JOB_WAIT_*` bounds are read.
 */
export function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
