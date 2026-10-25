import { stripVTControlCharacters } from 'node:util'

import type { ToolFacts, ToolTextWindow } from '@namzu/sdk'

import { displayPath } from './display-path.js'
import { formatSize, plural } from './person-terms.js'
import type { ShellOutput } from './shell-cell.js'
import { clipText, hiddenLinesHint } from './truncation.js'

export interface TidyOutput {
	/** What the transcript shows under the step. The retained raw output is untouched. */
	readonly output: string
	/** A plain headline for a failed command, when its output carried the exit status. */
	readonly failure?: string
	/** The same output split into streams for the shell cell; see `shell-cell.ts`. */
	readonly shell?: ShellOutput
}

/** The sentence under a command that was handed to a background job. */
export const BACKGROUND_NOTE = 'Running in the background (↓ to manage)'

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
		const output = 'The command printed binary data, which is not shown.'
		return { output, shell: { stdout: [], stderr: [], failed: false, note: output } }
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
	const output = kept.join('\n')
	const background = /^Started background job /.test(output)
	const code = failure ? /\d+/.exec(failure)?.[0] : undefined
	const shell: ShellOutput = {
		stdout: background || output.length === 0 ? [] : kept,
		stderr: [],
		failed: failure !== undefined,
		...(background ? { note: BACKGROUND_NOTE } : {}),
		...(failure ? { note: code ? `Exit code ${code}` : failure } : {}),
		...(failure && output.length > 0 && !background
			? { status: code ? `Exit code ${code}` : failure }
			: {}),
	}
	return { output, ...(failure ? { failure } : {}), shell }
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
export const NOT_SHOWN_LINE = /^… \+([\d,]+) lines?$/

/** One stream's window as lines: the first lines, a gap line, the last lines. */
function windowLines(window: ToolTextWindow): string[] {
	const lines = window.head.length > 0 ? window.head.split('\n') : []
	if (window.omittedLines) {
		lines.push(hiddenLinesHint(window.omittedLines, { canExpand: false }))
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
	// The cell says how it ended in a few words and never repeats the command.
	const status = !how
		? undefined
		: facts.timedOut
			? 'Timed out'
			: facts.signal
				? 'Stopped before it finished'
				: `Exit code ${facts.exitCode}`
	const cell = (
		stdout: readonly string[],
		stderr: readonly string[],
		note?: string,
	): ShellOutput => ({
		stdout,
		stderr,
		failed: how !== undefined,
		...(status && (stdout.length > 0 || stderr.length > 0) ? { status } : {}),
		...(status ? { note: status } : note ? { note } : {}),
	})
	const withFailure = (output: string, shell: ShellOutput): TidyOutput => ({
		output,
		...(failure ? { failure } : {}),
		shell,
	})
	if (facts.binary) {
		const sentence = `The command printed binary data (${formatSize(facts.binary.bytes)}), which is not shown.`
		return withFailure(sentence, cell([], [], sentence))
	}
	const clean = (window: ToolTextWindow | undefined): string[] =>
		window && window.totalBytes > 0
			? windowLines(window).map((line) => stripVTControlCharacters(line))
			: []
	const stdout = clean(facts.stdout)
	const stderr = clean(facts.stderr)
	if (stdout.length > 0 || stderr.length > 0) {
		return withFailure([...stdout, ...stderr].join('\n'), cell(stdout, stderr))
	}
	// Nothing was printed, or the call was handed to a background job: the
	// kernel's own sentence is the answer. Only its bookkeeping is removed.
	return withFailure(
		tidyTerminalOutput(raw).output,
		cell([], [], facts.background ? BACKGROUND_NOTE : undefined),
	)
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
export function failureFactsLine(
	facts: Extract<ToolFacts, { kind: 'failure' }>,
	cwd?: string,
): string {
	// A file named as the model gave it or relative to the working folder; a
	// tool's own name (for an unknown tool) is not a path and is left alone.
	const subject = facts.subject
		? facts.reason === 'unknown_tool'
			? facts.subject
			: displayPath(facts.subject, cwd)
		: undefined
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

/** The file's own name: a headline names the file, and the full path is not for the transcript. */
function fileName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '')
	return trimmed.split(/[\\/]/).pop() || trimmed
}

function clipped(text: string, max: number): string {
	return clipText(text.replace(/\s+/g, ' ').trim(), max)
}

/** `+2 −1`; a side with nothing is left out, and no change at all gives ''. */
function changeStats(added: number | undefined, removed: number | undefined): string {
	const parts: string[] = []
	if (added) parts.push(`+${added.toLocaleString('en-US')}`)
	if (removed) parts.push(`−${removed.toLocaleString('en-US')}`)
	return parts.join(' ')
}

/**
 * The one-line account of a finished read, search, write or edit, from the typed
 * facts the kernel reports (`ToolResult.facts`), not from the model's receipt:
 * "Read a.ts", "Searched for x · 2 matches in 2 files", "Edited a.ts +2 −1",
 * "Created n.txt +2". Undefined when the facts do not describe one of those, so
 * the caller keeps the text it already had (a conversation saved before facts
 * existed, or any other tool).
 */
export function factsHeadline(facts: ToolFacts | undefined): string | undefined {
	if (!facts) return undefined
	switch (facts.kind) {
		case 'read': {
			const name = fileName(facts.path)
			if (facts.binary) return `Read ${name} · not text`
			if (facts.partial && facts.returnedLines !== undefined && facts.totalLines !== undefined) {
				return `Read ${name} · ${facts.returnedLines.toLocaleString('en-US')} of ${plural(facts.totalLines, 'line')}`
			}
			return `Read ${name}`
		}
		case 'search': {
			const lead = `Searched for ${clipped(facts.pattern, 60)}`
			if (facts.matches === undefined) return lead
			let found =
				facts.matches === 0
					? 'no matches'
					: `${plural(facts.matches, 'match', 'matches')}${
							facts.filesMatched !== undefined ? ` in ${plural(facts.filesMatched, 'file')}` : ''
						}`
			if (facts.truncated) found = `${found}, more not shown`
			return `${lead} · ${found}`
		}
		case 'list': {
			const lead = `Listed ${clipped(facts.pattern, 60)}`
			if (facts.count === undefined) return lead
			const found = facts.count === 0 ? 'no files' : plural(facts.count, 'file')
			return `${lead} · ${facts.truncated ? `${found}, more not shown` : found}`
		}
		case 'write': {
			const name = fileName(facts.path)
			const lead =
				facts.operation === 'created'
					? 'Created'
					: facts.operation === 'updated'
						? 'Updated'
						: facts.operation === 'unchanged'
							? 'No changes to'
							: 'Wrote'
			const stats = changeStats(facts.added, facts.removed)
			return `${lead} ${name}${stats ? ` ${stats}` : ''}`
		}
		case 'edit': {
			if (!facts.path) return undefined
			// A final-newline-only change is +1 −1 in the kernel's count, so a real
			// change is never headlined as nothing.
			const stats = changeStats(facts.added, facts.removed)
			return `Edited ${fileName(facts.path)}${stats ? ` ${stats}` : ''}`
		}
		default:
			return undefined
	}
}
