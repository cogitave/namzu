import { stripVTControlCharacters } from 'node:util'

import type { ToolFacts, ToolTextWindow } from '@namzu/sdk'

import { formatSize, homePath, plural } from './person-terms.js'

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

type CommandFacts = Extract<ToolFacts, { kind: 'command' }>

/** The command line as a one-line label: first line, single spaces, cut at a word. */
function shortCommand(command: string | undefined): string | undefined {
	const line = command?.split('\n')[0]?.replace(/\s+/g, ' ').trim()
	if (!line) return undefined
	if (line.length <= 60) return line
	const cut = line.slice(0, 59)
	const space = cut.lastIndexOf(' ')
	return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** How a finished command ended, in the person's words; undefined when it simply succeeded. */
function endedHow(facts: CommandFacts): string | undefined {
	if (facts.background) return undefined
	if (facts.timedOut) return 'timed out'
	if (facts.signal) return 'was stopped before it finished'
	if (facts.exitCode !== undefined && facts.exitCode !== 0) {
		return `exited with code ${facts.exitCode}`
	}
	return undefined
}

/**
 * A detail line that stands for lines the kernel kept out of a long stream.
 * The transcript counts it as that many hidden lines when it collapses a body.
 */
export const NOT_SHOWN_LINE = /^… ([\d,]+) lines? not shown$/

/** One stream's window as lines: the first lines, a gap line, the last lines. */
function windowLines(window: ToolTextWindow): string[] {
	const lines = window.head.length > 0 ? window.head.split('\n') : []
	if (window.omittedLines) {
		lines.push(`… ${plural(window.omittedLines, 'line')} not shown`)
	}
	if (window.tail) lines.push(...window.tail.split('\n'))
	return lines
}

/**
 * A command's output as a person reads it, from the typed facts the kernel
 * reports with the result (`ToolResult.facts`), not from its prose.
 *
 * The exit code, a timeout or a signal come from the fields; a stream that was
 * not text is named; the body is the two streams' windows (first lines, a gap
 * line saying how many were left out, last lines), so the model's labels and
 * bookkeeping never reach the screen. A conversation saved before facts
 * existed does not reach this function: it keeps `tidyTerminalOutput`.
 */
export function tidyCommandOutput(facts: CommandFacts, raw: string): TidyOutput {
	const how = endedHow(facts)
	const label = shortCommand(facts.command)
	const failure = how
		? label
			? `Ran ${label} · ${how}`
			: `${how.charAt(0).toUpperCase()}${how.slice(1)}`
		: undefined
	const withFailure = (output: string): TidyOutput => ({ output, ...(failure ? { failure } : {}) })
	if (facts.binary) {
		return withFailure(
			`The command printed binary data (${formatSize(facts.binary.bytes)}), which is not shown.`,
		)
	}
	const streams = [facts.stdout, facts.stderr].filter(
		(w): w is ToolTextWindow => w !== undefined && w.totalBytes > 0,
	)
	if (streams.length > 0) {
		return withFailure(
			streams
				.flatMap(windowLines)
				.map((line) => stripVTControlCharacters(line))
				.join('\n'),
		)
	}
	// Nothing was printed, or the call was handed to a background job: the
	// kernel's own sentence is the answer. Only its bookkeeping is removed.
	return withFailure(tidyTerminalOutput(raw).output)
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

/** What the transcript says under a call the person answered No to. */
export function declinedLine(note: string | undefined): string {
	const said = note?.replace(/\s+/g, ' ').trim()
	return said
		? `You declined this, so it did not run. You said: “${said}”`
		: 'You declined this, so it did not run.'
}

/**
 * One sentence for a call the kernel refused or that could not do what it was
 * asked, from `ToolResult.facts` of kind `failure`, so the model's refusal text
 * ("Blocked by the authorization gate: … rewording it will not help") is never
 * what a person reads.
 */
export function failureFactsLine(facts: Extract<ToolFacts, { kind: 'failure' }>): string {
	const subject = facts.subject ? homePath(facts.subject) : undefined
	switch (facts.reason) {
		case 'not_found':
			return subject ? `Couldn’t find ${subject}.` : 'Couldn’t find that.'
		case 'permission_denied':
			return subject ? `No permission to use ${subject}.` : 'No permission to do that.'
		case 'not_a_file':
			return subject ? `${subject} is not a file.` : 'That is not a file.'
		case 'already_exists':
			return subject ? `${subject} already exists.` : 'That already exists.'
		case 'blocked':
			return 'Blocked: Namzu’s rules do not allow this here.'
		case 'needs_administrator':
			return 'Blocked: this command needs administrator rights.'
		case 'unknown_tool':
			return subject
				? `The model asked for a tool that does not exist (${subject}). It will try another way.`
				: 'The model asked for a tool that does not exist. It will try another way.'
		case 'timed_out':
			return 'It took too long and was stopped.'
		case 'invalid_input':
			return 'The model sent input this tool could not use.'
	}
}
