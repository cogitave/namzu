import { stripVTControlCharacters } from 'node:util'

import type { ToolFacts, ToolTextWindow } from '@namzu/sdk'

import { formatSize } from './person-terms.js'

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

/** A window holds the whole stream when nothing was left out and nothing was clipped. */
function windowIsComplete(window: ToolTextWindow): boolean {
	return (
		window.tail === undefined &&
		window.omittedLines === undefined &&
		Buffer.byteLength(window.head, 'utf8') >= window.totalBytes - 1
	)
}

/** Drop the `STDOUT:` / `STDERR:` labels the kernel put in the model's copy of the output. */
function withoutStreamLabels(text: string, has: { stdout: boolean; stderr: boolean }): string {
	let out = text
	if (has.stdout) out = out.replace(/^STDOUT:\n/, '')
	if (has.stderr) out = out.replace(/(^|\n\n?)STDERR:\n/, '$1')
	return out
}

/**
 * A command's output as a person reads it, from the typed facts the kernel
 * reports with the result (`ToolResult.facts`), not from its prose.
 *
 * The exit code, a timeout or a signal come from the fields; a stream that was
 * not text is named. When both streams fit their windows the body is the two
 * windows; otherwise it is the full retained text, so Ctrl+O still has all of
 * it. A conversation saved before facts existed does not reach this function:
 * it keeps `tidyTerminalOutput`.
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
	if (streams.length > 0 && streams.every(windowIsComplete)) {
		return withFailure(streams.map((w) => w.head).join('\n'))
	}
	// Long output: the retained text is the only complete copy. Its bookkeeping
	// lines are removed here; the exit status already came from the fields.
	const tidy = tidyTerminalOutput(
		withoutStreamLabels(raw, {
			stdout: (facts.stdout?.totalBytes ?? 0) > 0,
			stderr: (facts.stderr?.totalBytes ?? 0) > 0,
		}),
	)
	return withFailure(tidy.output)
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
