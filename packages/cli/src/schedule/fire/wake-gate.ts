/**
 * The wake-gate output contract for a `script+agent` job: the gate script's
 * stdout must be exactly one JSON line — its own last line, or its only
 * line (trailing blank lines tolerated) — of the shape `{"wake": boolean,
 * "context": string}`. Everything else the script writes is captured for
 * the run record (`fire/run-script.ts`'s output, separately) but is never
 * parsed as the contract.
 *
 * Parse failures are mechanical, not a judgement about whether the AGENT
 * half would have succeeded: non-JSON stdout, a JSON value that is not an
 * object, a missing/non-boolean `wake`, a non-string `context`, or more
 * than one line of stdout that independently parses as JSON (ambiguous —
 * which one is the answer?) are all refused the same way, by the caller,
 * as `check-failed`.
 */

export interface WakeGateResult {
	readonly wake: boolean
	/** Cut to the job's `wakeGate.maxContextChars`, with an explicit marker — never silently. */
	readonly context: string
}

export type WakeGateOutcome =
	| { readonly ok: true; readonly result: WakeGateResult }
	| { readonly ok: false; readonly reason: string }

/** Text as a refusal quotes it: one line, cut to fit, in backticks. */
function shown(text: string, max = 200): string {
	const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
	const cut = [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
	return cut.includes('`') ? `\`\` ${cut} \`\`` : `\`${cut}\``
}

function isJson(line: string): boolean {
	try {
		JSON.parse(line)
		return true
	} catch {
		return false
	}
}

/** Parse a wake-gate's stdout against the contract, capping `context` at `maxContextChars`. */
export function parseWakeGateOutput(stdout: string, maxContextChars: number): WakeGateOutcome {
	const lines = stdout.split(/\r?\n/)
	while (lines.length > 0 && (lines.at(-1) as string).trim() === '') lines.pop()
	if (lines.length === 0) {
		return {
			ok: false,
			reason:
				'the wake-gate script produced no output; it must print exactly one JSON line, {"wake": boolean, "context": string}',
		}
	}
	const last = lines.at(-1) as string
	if (!isJson(last)) {
		return {
			ok: false,
			reason: `the wake-gate script's stdout does not end with JSON: ${shown(last)}`,
		}
	}
	const earlierJsonLines = lines.slice(0, -1).filter((line) => line.trim() !== '' && isJson(line))
	if (earlierJsonLines.length > 0) {
		return {
			ok: false,
			reason:
				'the wake-gate script printed more than one line of JSON stdout; it must print exactly one, as its last line',
		}
	}
	const value: unknown = JSON.parse(last)
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {
			ok: false,
			reason: `the wake-gate script's JSON line is not an object: ${shown(last)}`,
		}
	}
	const record = value as Record<string, unknown>
	if (typeof record.wake !== 'boolean') {
		return {
			ok: false,
			reason: `the wake-gate script's JSON has no boolean "wake": ${shown(last)}`,
		}
	}
	if (typeof record.context !== 'string') {
		return {
			ok: false,
			reason: `the wake-gate script's JSON has no string "context": ${shown(last)}`,
		}
	}
	const context =
		record.context.length > maxContextChars
			? `${record.context.slice(0, maxContextChars)}\n...(truncated)`
			: record.context
	return { ok: true, result: { wake: record.wake, context } }
}
