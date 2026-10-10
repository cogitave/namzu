import { stripVTControlCharacters } from 'node:util'

export interface TidyOutput {
	/** What the transcript shows under the step. The retained raw output is untouched. */
	readonly output: string
	/** A plain headline for a failed command, when its output carried the exit status. */
	readonly failure?: string
}

/** Output that is not text: a NUL byte, or a large share of control characters. */
export function looksBinary(text: string): boolean {
	if (text.includes('\u0000')) return true
	if (text.length === 0) return false
	let controls = 0
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27) controls++
	}
	return controls / text.length > 0.1
}

/**
 * Command output as a person reads it.
 *
 * The kernel's bash result carries bookkeeping lines meant for the model: a
 * note about withheld credentials and an `Error: Command exited with code N`
 * trailer. Neither belongs in the transcript. ANSI colour is stripped (the
 * terminal that drew it is not the one drawing it now) and binary output is
 * named rather than dumped. Long output is not cut here: the transcript already
 * collapses it to its first and last lines with a count, and Ctrl+O expands the
 * whole text, which must stay complete.
 *
 * This works from the text because the SDK does not yet carry exit status or
 * stream separation as structured fields; when it does, the two prose matches
 * below are replaced by those fields and nothing else here changes.
 */
export function tidyTerminalOutput(raw: string): TidyOutput {
	if (looksBinary(raw)) {
		return { output: 'The command printed binary data, which is not shown.' }
	}
	let failure: string | undefined
	const kept: string[] = []
	for (const line of stripVTControlCharacters(raw).split('\n')) {
		if (/^NOTE: \d+ credential-shaped environment variable/.test(line)) continue
		const exit = /^Error: Command exited with code (\d+)\s*$/.exec(line)
		if (exit) {
			failure = `Exited with code ${exit[1]}`
			continue
		}
		kept.push(line)
	}
	while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()
	return { output: kept.join('\n'), ...(failure ? { failure } : {}) }
}

/**
 * The model asked for a tool that does not exist. The kernel's message lists
 * every internal tool name; the person needs one sentence.
 */
export function unknownToolNotice(result: string): string | undefined {
	const named = /^Error: Unknown tool "([^"]{1,80})"/.exec(result.trim())
	return named
		? `The model asked for a tool that does not exist (${named[1]}). It will try another way.`
		: undefined
}
