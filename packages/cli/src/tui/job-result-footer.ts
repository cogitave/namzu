/**
 * The last line a background-job tool result ends with, written for the model:
 * `[job <id> is exited with code 0; next_offset 2010; the whole output is in <path>]`
 * or `[next_offset 2010; ...]`. It carries the cursor to read from next and the
 * path of a temp file, neither of which the person reading the transcript can use.
 */
const JOB_RESULT_FOOTER = /\n*\[(?:job \S+ is [^;\]\n]+; )?next_offset \d+[^\]\n]*\]\s*$/u

const JOB_TOOLS: ReadonlySet<string> = new Set(['job', 'wait_for_job'])

/** A job tool's result as the person is shown it: the output without the model's cursor line. */
export function withoutJobFooter(toolName: string, result: string): string {
	return JOB_TOOLS.has(toolName) ? result.replace(JOB_RESULT_FOOTER, '') : result
}
