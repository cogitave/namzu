/**
 * Shell commands written inside a skill or a custom command, run while the
 * text loads.
 *
 * Two forms, both read by {@link findInlineShell}:
 *
 * - A fenced block opened by a line that is three backticks and a bang, closed
 *   by a line of three backticks. Everything between is ONE command, so a
 *   multi-line script runs as a single shell call.
 * - Inline: a bang and a backtick span, `!` then a backtick, the command, a
 *   backtick, where the bang starts the text or follows whitespace.
 *
 * An ordinary backtick span and an ordinary fence are masked first, so the
 * documentation a skill shows (a command in code font, an example block)
 * never runs. An unterminated shell fence is plain text.
 *
 * This file is pure: no process, no permission, no file. {@link expandInlineShell}
 * takes the host's way of running one command (permission check, the hook, the
 * shell tool) and decides everything around it: limits, placeholders, how the
 * output replaces the marker, what fails the load.
 *
 * ## Arguments can never start a command
 *
 * The order is: substitute `$ARGUMENTS` and the variables, then read the
 * commands. A value a person typed (or a model sent) is therefore text that
 * the reader sees, so {@link substituteEscaped} rewrites the three shapes that
 * would begin a command, and refuses the load if a value managed to add one
 * anyway.
 */

/** Most commands one expansion may run. */
export const INLINE_SHELL_MAX_COMMANDS = 256
/** Longest command text, in characters. */
export const INLINE_SHELL_MAX_COMMAND_CHARS = 32_768
/** Most characters of command output one expansion may put into the text. */
export const INLINE_SHELL_MAX_OUTPUT_CHARS = 4_000_000
/** The longest reason from a hook that is shown. */
export const INLINE_SHELL_REASON_CHARS = 500
/** The longest command shown in a warning. */
export const INLINE_SHELL_COMMAND_SHOWN_CHARS = 80

export type InlineShellKind = 'fence' | 'inline'

/** One command found in a text: the marker as written, and where it sits. */
export interface InlineShellMarker {
	readonly kind: InlineShellKind
	/** Offset of the first character of the marker, in the normalised text. */
	readonly start: number
	/** Offset just past the last character of the marker. */
	readonly end: number
	/** The command, trimmed. */
	readonly command: string
	/** The marker as written. */
	readonly raw: string
}

/** The text with line endings as `\n`, which is the text every offset refers to. */
export function normalizeInlineShellText(text: string): string {
	return text.replace(/\r\n?/g, '\n')
}

const SHELL_FENCE_OPEN = /^[ \t]*```![ \t]*$/
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/

/**
 * Every command in the text, in order. Offsets refer to
 * {@link normalizeInlineShellText} of the text; {@link expandInlineShell} does
 * that first, and a caller that splices by hand must do the same.
 */
export function findInlineShell(text: string): InlineShellMarker[] {
	const source = normalizeInlineShellText(text)
	const markers: InlineShellMarker[] = []
	const lines = source.split('\n')
	const starts: number[] = []
	let running = 0
	for (const line of lines) {
		starts.push(running)
		running += line.length + 1
	}
	const endOf = (i: number): number => (starts[i] as number) + (lines[i] as string).length
	// Ranges that hold a fence: nothing inside them is read for an inline command.
	const fenced: Array<{ from: number; to: number }> = []

	let i = 0
	while (i < lines.length) {
		const line = lines[i] as string
		if (SHELL_FENCE_OPEN.test(line)) {
			let close = -1
			for (let j = i + 1; j < lines.length; j++) {
				if (/^[ \t]*```[ \t]*$/.test(lines[j] as string)) {
					close = j
					break
				}
			}
			if (close === -1) {
				// Never closed: plain text.
				i += 1
				continue
			}
			const command = lines
				.slice(i + 1, close)
				.join('\n')
				.trim()
			if (command.length > 0) {
				const start = starts[i] as number
				const end = endOf(close)
				markers.push({ kind: 'fence', start, end, command, raw: source.slice(start, end) })
				fenced.push({ from: start, to: end })
			}
			i = close + 1
			continue
		}
		const fence = FENCE_LINE.exec(line)
		if (fence !== null) {
			const mark = fence[1] as string
			const char = mark[0] as string
			const info = fence[2] as string
			// A backtick fence cannot have a backtick in its info string; that line is an ordinary span.
			if (!(char === '`' && info.includes('`'))) {
				let close = -1
				for (let j = i + 1; j < lines.length; j++) {
					const candidate = (lines[j] as string).trim()
					if (candidate.length >= mark.length && [...candidate].every((c) => c === char)) {
						close = j
						break
					}
				}
				// An ordinary fence with no close runs to the end of the text, as it does when read.
				const last = close === -1 ? lines.length - 1 : close
				fenced.push({ from: starts[i] as number, to: endOf(last) })
				i = last + 1
				continue
			}
		}
		i += 1
	}

	let at = 0
	for (const gap of fenced) {
		if (gap.from > at) for (const m of inlineMarkers(source, at, gap.from)) markers.push(m)
		at = Math.max(at, gap.to)
	}
	if (at < source.length) for (const m of inlineMarkers(source, at, source.length)) markers.push(m)
	markers.sort((x, y) => x.start - y.start)
	return markers
}

/** The inline commands between two offsets, ordinary code spans set aside. */
function inlineMarkers(source: string, from: number, to: number): InlineShellMarker[] {
	const found: InlineShellMarker[] = []
	let i = from
	while (i < to) {
		if (source[i] !== '`') {
			i += 1
			continue
		}
		let runEnd = i
		while (runEnd < to && source[runEnd] === '`') runEnd += 1
		const length = runEnd - i
		const bang = i > from && source[i - 1] === '!'
		const bangStart = i - 1
		const startsText = bangStart === from || /\s/.test(source[bangStart - 1] ?? '')
		if (bang && length === 1 && startsText) {
			// The body is every character up to the next backtick, and has some.
			const close = source.indexOf('`', runEnd)
			if (close !== -1 && close < to && close > runEnd) {
				const command = source.slice(runEnd, close).trim()
				if (command.length > 0) {
					found.push({
						kind: 'inline',
						start: bangStart,
						end: close + 1,
						command,
						raw: source.slice(bangStart, close + 1),
					})
				}
				i = close + 1
				continue
			}
			i = runEnd
			continue
		}
		// An ordinary span: closed by a run of the same length. Masked whole.
		let search = runEnd
		let closed = -1
		while (search < to) {
			const at = source.indexOf('`', search)
			if (at === -1 || at >= to) break
			let end = at
			while (end < to && source[end] === '`') end += 1
			if (end - at === length) {
				closed = end
				break
			}
			search = end
		}
		i = closed === -1 ? runEnd : closed
	}
	return found
}

/**
 * A value made safe to put into a text that is read for commands afterwards:
 * the shapes that open a command are broken by a space, and a leading bang is
 * escaped so the template's own backtick after it cannot complete one.
 */
export function escapeInlineShell(value: string): string {
	let out = value.replaceAll('!`', '! `').replaceAll('`!', '` !')
	if (out.startsWith('!')) out = `\\${out}`
	return out
}

/** A value is put where `before` and `after` are the template's characters around it. */
function escapeBetween(value: string, before: string, after: string): string {
	let out = escapeInlineShell(value)
	if (before === '!' && out.startsWith('`')) out = ` ${out}`
	if (after === '`' && out.endsWith('!')) out = `${out} `
	if (after === '!' && out.endsWith('`')) out = `${out} `
	return out
}

/** A load that cannot go on: the reason is the message, and what to do about it is in it. */
export class InlineShellError extends Error {
	constructor(
		message: string,
		readonly reason: 'failed' | 'interrupted' | 'permission' | 'limit' | 'stopped' | 'injection',
	) {
		super(message)
		this.name = 'InlineShellError'
	}
}

/**
 * Put values into a template, each escaped, and prove no value added a
 * command. `values` maps the token written in the text (`$ARGUMENTS`) to its
 * value. Throws {@link InlineShellError} when the substituted text holds more
 * commands than the template does.
 */
export function substituteEscaped(
	template: string,
	values: Readonly<Record<string, string>>,
): string {
	const normalized = normalizeInlineShellText(template)
	const tokens = Object.keys(values).filter((token) => token.length > 0)
	if (tokens.length === 0) return normalized
	// Longest first, so `$ARGUMENTS_X` is never read as `$ARGUMENTS` plus a tail.
	tokens.sort((a, b) => b.length - a.length)
	let out = ''
	let neutral = ''
	let i = 0
	while (i < normalized.length) {
		const token = tokens.find((candidate) => normalized.startsWith(candidate, i))
		if (token === undefined) {
			out += normalized[i]
			neutral += normalized[i]
			i += 1
			continue
		}
		const before = normalized[i - 1] ?? ''
		const after = normalized[i + token.length] ?? ''
		out += escapeBetween(values[token] as string, before, after)
		// The same text with a word where the value goes: the commands the author wrote.
		neutral += 'x'
		i += token.length
	}
	if (findInlineShell(out).length > findInlineShell(neutral).length) {
		throw new InlineShellError(
			'A value given to this skill or command contains text that would start a shell command, so it was not loaded.',
			'injection',
		)
	}
	return out
}

export const SHELL_OFF_PLACEHOLDER =
	'[shell commands are turned off (disableSkillShellExecution), so this command was not run]'
export const SHELL_REMOTE_PLACEHOLDER =
	'[shell commands are not run in text that comes from a tool server or another remote source, so this command was not run]'
export const SHELL_UNTRUSTED_PLACEHOLDER =
	'[shell commands are not run until this folder is trusted, so this command was not run]'

export const SHELL_PRELOAD_PLACEHOLDER =
	'[shell commands in a skill preloaded into an agent are not run when the agent is set up, so this command was not run]'

/** Why a command in this text may not run at all, before any is tried. */
export type InlineShellBlock = 'off' | 'remote' | 'untrusted' | 'preload'

const PLACEHOLDERS: Readonly<Record<InlineShellBlock, string>> = {
	off: SHELL_OFF_PLACEHOLDER,
	remote: SHELL_REMOTE_PLACEHOLDER,
	untrusted: SHELL_UNTRUSTED_PLACEHOLDER,
	preload: SHELL_PRELOAD_PLACEHOLDER,
}

/** What a hook said about one command. */
export type InlineShellHookVerdict =
	| { readonly kind: 'run'; readonly warning?: string }
	/** Not this command; the rest of the text loads. */
	| { readonly kind: 'refuse'; readonly reason?: string; readonly warning?: string }
	/** The whole load stops. */
	| { readonly kind: 'stop'; readonly reason: string }

/** How the host ended one command. */
export type InlineShellOutcome =
	/** The permission rules said no, or would have asked a person who is not there. */
	| { readonly kind: 'denied'; readonly reason: string }
	/** The hook, which runs after permission and before the shell, refused or stopped. */
	| { readonly kind: 'hook'; readonly verdict: Exclude<InlineShellHookVerdict, { kind: 'run' }> }
	| {
			readonly kind: 'ran'
			readonly stdout: string
			readonly stderr: string
			/** Zero is success. `null` when the command did not report one. */
			readonly exitCode: number | null
			readonly interrupted?: boolean
	  }

export interface InlineShellHost {
	/**
	 * Run one command: check permission, then call `beforeRun`, then start it.
	 * `beforeRun` must be called exactly when the permission check has allowed
	 * the command and the command has not started, and a verdict other than
	 * `run` must end the call with `{ kind: 'hook', verdict }`.
	 */
	run(
		command: string,
		beforeRun: () => Promise<InlineShellHookVerdict>,
	): Promise<InlineShellOutcome>
}

export interface InlineShellOptions {
	readonly host: InlineShellHost
	/** The skill or command, for the line a warning names. */
	readonly commandName: string
	/** Set when no command may run; each is replaced by the matching placeholder. */
	readonly block?: InlineShellBlock
	/** Absent when no hook is attached for the event: nothing is asked. */
	readonly hook?: (command: string) => Promise<InlineShellHookVerdict>
	/** A line for the person, for a refused command and a warning from a hook. */
	readonly warn?: (line: string) => void
	readonly signal?: AbortSignal
}

/** `/name` for a line a person reads. */
function shown(name: string): string {
	return `/${name}`
}

function cut(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Trimmed standard output, then a `[stderr]` block when there is any standard error. */
export function shapeShellOutput(stdout: string, stderr: string): string {
	const out = stdout.trim()
	const err = stderr.trim()
	if (err === '') return out
	return out === '' ? `[stderr]\n${err}` : `${out}\n[stderr]\n${err}`
}

/**
 * Run every command in `text` and put each one's output where it was written.
 *
 * Commands run one after another, in order. A load fails (throws
 * {@link InlineShellError}) on: more than 256 commands, a command over 32 KB,
 * more than 4 MB of output in all, a permission refusal, a non-zero exit, an
 * interrupt, or a hook's request to stop. A hook that refuses one command
 * leaves `[not run: blocked by hook: <reason>]` in its place and loads the rest.
 */
export async function expandInlineShell(
	text: string,
	options: InlineShellOptions,
): Promise<string> {
	const source = normalizeInlineShellText(text)
	const markers = findInlineShell(source)
	if (markers.length === 0) return source
	if (options.block !== undefined) {
		const placeholder = PLACEHOLDERS[options.block]
		return replaceMarkers(source, markers, () => placeholder)
	}
	if (markers.length > INLINE_SHELL_MAX_COMMANDS) {
		throw new InlineShellError(
			`${shown(options.commandName)} has ${markers.length} shell commands, and at most ${INLINE_SHELL_MAX_COMMANDS} may run while it loads.`,
			'limit',
		)
	}
	for (const marker of markers) {
		if (marker.command.length > INLINE_SHELL_MAX_COMMAND_CHARS) {
			throw new InlineShellError(
				`A shell command in ${shown(options.commandName)} is ${marker.command.length} characters, and at most ${INLINE_SHELL_MAX_COMMAND_CHARS} may run while it loads.`,
				'limit',
			)
		}
	}

	const replacements: string[] = []
	let total = 0
	for (const marker of markers) {
		options.signal?.throwIfAborted()
		const pattern = cut(marker.command, INLINE_SHELL_COMMAND_SHOWN_CHARS)
		const beforeRun = async (): Promise<InlineShellHookVerdict> => {
			if (options.hook === undefined) return { kind: 'run' }
			return options.hook(marker.command)
		}
		const outcome = await options.host.run(marker.command, beforeRun)
		if (outcome.kind === 'denied') {
			throw new InlineShellError(
				`Shell command permission check failed for pattern "${pattern}": ${outcome.reason}`,
				'permission',
			)
		}
		if (outcome.kind === 'hook') {
			const verdict = outcome.verdict
			if (verdict.kind === 'stop') {
				throw new InlineShellError(
					`${shown(options.commandName)} was stopped by a hook: ${cut(verdict.reason, INLINE_SHELL_REASON_CHARS)}`,
					'stopped',
				)
			}
			const reason =
				verdict.reason === undefined || verdict.reason.trim() === ''
					? undefined
					: cut(verdict.reason, INLINE_SHELL_REASON_CHARS)
			if (verdict.warning) options.warn?.(verdict.warning)
			options.warn?.(
				`Not run in ${shown(options.commandName)}: ${pattern} (blocked by hook${reason ? `: ${reason}` : ''})`,
			)
			replacements.push(`[not run: blocked by hook${reason ? `: ${reason}` : ''}]`)
			continue
		}
		if (outcome.interrupted === true) {
			throw new InlineShellError(
				`Shell command interrupted for pattern "${pattern}": [Command interrupted]`,
				'interrupted',
			)
		}
		if (outcome.exitCode !== 0) {
			const output = shapeShellOutput(outcome.stdout, outcome.stderr)
			throw new InlineShellError(
				`Shell command failed for pattern "${pattern}": ${output === '' ? `exit code ${outcome.exitCode ?? 'unknown'}` : output}`,
				'failed',
			)
		}
		const shaped = shapeShellOutput(outcome.stdout, outcome.stderr)
		total += shaped.length
		if (total > INLINE_SHELL_MAX_OUTPUT_CHARS) {
			throw new InlineShellError(
				`The shell commands in ${shown(options.commandName)} printed more than ${INLINE_SHELL_MAX_OUTPUT_CHARS} characters in all, which is the most a load may take in.`,
				'limit',
			)
		}
		replacements.push(shaped)
	}
	let n = 0
	return replaceMarkers(source, markers, () => replacements[n++] as string)
}

function replaceMarkers(
	source: string,
	markers: readonly InlineShellMarker[],
	replacement: (marker: InlineShellMarker) => string,
): string {
	let out = ''
	let at = 0
	for (const marker of markers) {
		out += source.slice(at, marker.start) + replacement(marker)
		at = marker.end
	}
	return out + source.slice(at)
}

/**
 * Turn the text of a bash tool result into its two streams. The tool labels
 * them `STDOUT:` and `STDERR:`; a result with neither label is all standard
 * output, and `(no output)` is nothing.
 */
export function splitShellToolOutput(output: string): { stdout: string; stderr: string } {
	if (output === '(no output)') return { stdout: '', stderr: '' }
	if (output.startsWith('STDERR:\n'))
		return { stdout: '', stderr: output.slice('STDERR:\n'.length) }
	if (!output.startsWith('STDOUT:\n')) return { stdout: output, stderr: '' }
	const body = output.slice('STDOUT:\n'.length)
	const split = body.indexOf('\n\nSTDERR:\n')
	if (split === -1) return { stdout: body, stderr: '' }
	return { stdout: body.slice(0, split), stderr: body.slice(split + '\n\nSTDERR:\n'.length) }
}
