/**
 * Variables a hook sets for the commands that run after it.
 *
 * A person's shell picks up a project's environment when they enter its
 * folder. A hook on `session_start`, `cwd_changed` or `file_changed` can do
 * the same for the session's shell commands: it is started with
 * `NAMZU_ENV_FILE`, the path of a file kept for the session outside the
 * project, and appends lines of the form `export NAME=value` to it. The
 * commands the shell tool runs afterwards start with those variables.
 *
 * ## What is read
 *
 * The file is read as data and never run. A line is, after leading white
 * space, `export NAME=value` or `NAME=value`; blank lines and lines starting
 * with `#` are skipped. A value is a run of text with no white space or shell
 * punctuation, a single-quoted string (taken literally), or a double-quoted
 * string (`\"`, `\\`, `\$` and a backquote escaped are read as the character
 * itself); the three may be joined (`"a b"'c'd`). `$NAME` and `${NAME}` are
 * replaced by the value the name has in the environment the session was
 * started with or was set earlier (in this file or by an earlier kind of hook
 * below), and by nothing when it has none. Nothing else is expanded: a line
 * with `$(...)`, a backquote, `$((...))`, `${NAME:-x}` or any other
 * parameter form is not read at all, and is reported instead, so a command is
 * never run by us on a hook's behalf. A trailing ` # comment` is ignored.
 *
 * ## Which line wins
 *
 * A later line for the same name replaces an earlier one. There is no unset:
 * to remove a variable, set it empty. The three kinds of hook have a file
 * each, and a later kind outranks an earlier one: `session_start`, then
 * `cwd_changed`, then `file_changed`. A change of the working folder clears
 * what `cwd_changed` and `file_changed` hooks set (they describe the folder
 * that was left) before the `cwd_changed` hooks run again, and keeps what
 * `session_start` hooks set.
 *
 * ## Bounds
 *
 * Only the first 64 KiB of a file is read. A value longer than 8 KiB, a name
 * longer than 128 characters and a variable beyond the 128th are left out
 * and reported.
 *
 * ## Which names are refused
 *
 * `PATH` is allowed: it is the point of the feature. Refused, and reported
 * once, are the names that decide what program a command runs without being
 * a program named in it, and the ones that say where Namzu keeps its state:
 * every `NAMZU_*` name, the dynamic loader's (`LD_*`, `DYLD_*`), the shell's
 * start-up and prompt hooks (`BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`,
 * `PROMPT_COMMAND`, `PS4`, `IFS`, `CDPATH`, `BASH_FUNC_*`), and the
 * interpreters' own injection variables (`NODE_OPTIONS`, `PYTHONSTARTUP`,
 * `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`), plus the places the
 * home of the account and the user-level application folders live
 * (`HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
 * `XDG_CACHE_HOME`).
 */

import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTempDirSync } from '../utils/temp.js'

/** The events whose hooks may set variables, in the order a later one outranks an earlier one. */
export const HOOK_ENV_EVENTS = ['session_start', 'cwd_changed', 'file_changed'] as const
export type HookEnvEvent = (typeof HOOK_ENV_EVENTS)[number]

/** The most bytes of a hook's file that are read. */
export const MAX_HOOK_ENV_FILE_BYTES = 64 * 1024
/** The longest value kept, in characters. */
export const MAX_HOOK_ENV_VALUE_CHARS = 8 * 1024
/** The most variables hooks may have set at once. */
export const MAX_HOOK_ENV_VARIABLES = 128
const MAX_NAME_CHARS = 128

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const REFUSED_NAMES: ReadonlySet<string> = new Set([
	'BASH_ENV',
	'ENV',
	'SHELLOPTS',
	'BASHOPTS',
	'PROMPT_COMMAND',
	'PS4',
	'IFS',
	'CDPATH',
	'NODE_OPTIONS',
	'PYTHONSTARTUP',
	'PERL5OPT',
	'PERL5LIB',
	'RUBYOPT',
	'JAVA_TOOL_OPTIONS',
	'GCONV_PATH',
	'LOCPATH',
	'NLSPATH',
	'HOSTALIASES',
	'HOME',
	'USERPROFILE',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_CACHE_HOME',
])

/** Why a hook may not set `name`, in a sentence, or `undefined` when it may. */
export function refusedHookEnvName(name: string): string | undefined {
	if (name.startsWith('NAMZU_')) {
		return `${name} is one of Namzu's own settings, and a hook may not change those`
	}
	if (name.startsWith('LD_') || name.startsWith('DYLD_') || name === 'GCONV_PATH') {
		return `${name} is a dynamic loader variable: it changes what code every command loads`
	}
	if (name.startsWith('BASH_FUNC_')) {
		return `${name} defines a shell function that every command would run`
	}
	if (REFUSED_NAMES.has(name)) {
		return `${name} decides what program runs, or where Namzu and the account keep their state`
	}
	return undefined
}

interface Reading {
	readonly name: string
	readonly value: string
}

/** What went wrong with one line, or the pair it set. */
type Line = { readonly ok: Reading } | { readonly skip: true } | { readonly problem: string }

/**
 * One value: quoted and unquoted pieces joined, then only white space or a
 * ` #` comment. Returns the text, or why it cannot be read.
 */
function readValue(
	text: string,
	lookup: (name: string) => string,
): { readonly value: string } | { readonly problem: string } {
	let out = ''
	let i = 0
	const expand = (source: string, at: number): { next: number } | { problem: string } => {
		// `source[at]` is `$`.
		const after = source[at + 1]
		if (after === '(' || after === '`') {
			return { problem: 'it contains a command substitution, which is never run' }
		}
		if (after === '{') {
			const close = source.indexOf('}', at + 2)
			const inner = close < 0 ? '' : source.slice(at + 2, close)
			if (!NAME.test(inner)) {
				return { problem: 'it uses a form of `${...}` other than `${NAME}`, which is not read' }
			}
			out += lookup(inner)
			return { next: close + 1 }
		}
		if (after !== undefined && /[A-Za-z_]/.test(after)) {
			let end = at + 2
			while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1
			out += lookup(source.slice(at + 1, end))
			return { next: end }
		}
		out += '$'
		return { next: at + 1 }
	}
	while (i < text.length) {
		const ch = text[i] as string
		if (ch === "'") {
			const close = text.indexOf("'", i + 1)
			if (close < 0) return { problem: 'a single quote is never closed' }
			out += text.slice(i + 1, close)
			i = close + 1
		} else if (ch === '"') {
			i += 1
			let closed = false
			while (i < text.length) {
				const c = text[i] as string
				if (c === '"') {
					closed = true
					i += 1
					break
				}
				if (c === '\\' && i + 1 < text.length) {
					const nextChar = text[i + 1] as string
					if (nextChar === '"' || nextChar === '\\' || nextChar === '$' || nextChar === '`') {
						out += nextChar
						i += 2
						continue
					}
					out += c
					i += 1
					continue
				}
				if (c === '`') return { problem: 'it contains a command substitution, which is never run' }
				if (c === '$') {
					const step = expand(text, i)
					if ('problem' in step) return step
					i = step.next
					continue
				}
				out += c
				i += 1
			}
			if (!closed) return { problem: 'a double quote is never closed' }
		} else if (/\s/.test(ch)) {
			const rest = text.slice(i).trim()
			if (rest === '' || rest.startsWith('#')) break
			return { problem: 'it has text after the value that a shell would read as another word' }
		} else if (ch === '$') {
			const step = expand(text, i)
			if ('problem' in step) return step
			i = step.next
		} else if (ch === '`' || ';&|<>()'.includes(ch)) {
			return { problem: `it has "${ch}" outside quotes, which a shell would act on` }
		} else if (ch === '\\' && i + 1 < text.length) {
			out += text[i + 1] as string
			i += 2
		} else {
			out += ch
			i += 1
		}
	}
	return { value: out }
}

/** One line of a hook's file. */
export function readHookEnvLine(raw: string, lookup: (name: string) => string): Line {
	const line = raw.trim()
	if (line === '' || line.startsWith('#')) return { skip: true }
	const body = /^export\s+/.test(line) ? line.replace(/^export\s+/, '') : line
	const eq = body.indexOf('=')
	if (eq <= 0) {
		// `export NAME` re-exports what is already there: nothing to carry.
		return NAME.test(body) && body !== line ? { skip: true } : { problem: 'it is not NAME=value' }
	}
	const name = body.slice(0, eq)
	if (!NAME.test(name) || name.length > MAX_NAME_CHARS) {
		return { problem: `"${name.slice(0, 40)}" is not a variable name` }
	}
	const refusal = refusedHookEnvName(name)
	if (refusal !== undefined) return { problem: refusal }
	const value = readValue(body.slice(eq + 1), lookup)
	if ('problem' in value) return { problem: value.problem }
	if (value.value.length > MAX_HOOK_ENV_VALUE_CHARS) {
		return { problem: `its value is longer than ${MAX_HOOK_ENV_VALUE_CHARS} characters` }
	}
	if (value.value.includes('\0')) return { problem: 'its value has a NUL character' }
	return { ok: { name, value: value.value } }
}

export interface SessionHookEnvOptions {
	/** The environment `$NAME` is read from besides what hooks set. Default `process.env`. */
	readonly inherited?: () => NodeJS.ProcessEnv
	/** Called once for each distinct thing that was not read or not allowed. */
	readonly onProblem?: (message: string) => void
	/** Where the files go; default a private folder under Namzu's own scratch space, made on first use. */
	readonly directory?: () => string
}

/**
 * The variables hooks have set in one session. `variables` is one live
 * object, changed in place: hand it to the shell tool as its environment and
 * every command starts with what hooks have set so far.
 */
export class SessionHookEnv {
	/** What hooks have set, live. Do not write to it. */
	// No prototype, so a variable called `__proto__` is a variable like any other.
	readonly variables: Record<string, string> = Object.create(null)
	private readonly layers = new Map<HookEnvEvent, Map<string, string>>()
	private readonly reported = new Set<string>()
	private directory: string | undefined
	private disposed = false

	constructor(private readonly options: SessionHookEnvOptions = {}) {}

	/** The file a hook of `event` is told to append to; made on first use. */
	fileFor(event: HookEnvEvent): string | undefined {
		if (this.disposed) return undefined
		try {
			if (this.directory === undefined) {
				this.directory = this.options.directory?.() ?? createTempDirSync('hook-env')
				mkdirSync(this.directory, { recursive: true, mode: 0o700 })
			}
			const file = join(this.directory, `${event}.env`)
			// Created empty, owner-only, so a hook that appends finds it there.
			writeFileSync(file, '', { flag: 'a', mode: 0o600 })
			return file
		} catch (error) {
			this.report(
				`Namzu could not make the file hooks set variables in (${error instanceof Error ? error.message : String(error)}), so no hook can set a variable for this session.`,
			)
			return undefined
		}
	}

	/** Read `event`'s file again and recompute what is set. Call after a hook of that event ends. */
	absorb(event: HookEnvEvent): void {
		if (this.disposed || this.directory === undefined) return
		const text = this.readFile(join(this.directory, `${event}.env`))
		if (text === undefined) return
		this.layers.set(event, this.parse(event, text))
		this.merge()
	}

	/** Forget what `cwd_changed` and `file_changed` hooks set: it described the folder that was left. */
	clearFolderLayers(): void {
		if (this.disposed) return
		for (const event of ['cwd_changed', 'file_changed'] as const) {
			this.layers.delete(event)
			if (this.directory !== undefined) {
				try {
					writeFileSync(join(this.directory, `${event}.env`), '', { mode: 0o600 })
				} catch {
					// A file that cannot be emptied is read again at the next absorb.
				}
			}
		}
		this.merge()
	}

	/** The names set now and the kind of hook that set each, never the values. */
	describe(): readonly { readonly name: string; readonly event: HookEnvEvent }[] {
		const out = new Map<string, HookEnvEvent>()
		for (const event of HOOK_ENV_EVENTS) {
			for (const name of this.layers.get(event)?.keys() ?? []) out.set(name, event)
		}
		return [...out].map(([name, event]) => ({ name, event }))
	}

	/** Remove the files. The live object is emptied too. */
	dispose(): void {
		this.disposed = true
		this.layers.clear()
		this.merge()
		if (this.directory !== undefined) {
			try {
				rmSync(this.directory, { recursive: true, force: true })
			} catch {
				// Scratch space is cleaned up by the operating system in the end.
			}
			this.directory = undefined
		}
	}

	private report(message: string): void {
		if (this.reported.has(message)) return
		this.reported.add(message)
		this.options.onProblem?.(message)
	}

	private readFile(path: string): string | undefined {
		let fd: number | undefined
		try {
			fd = openSync(path, 'r')
			const buffer = Buffer.alloc(MAX_HOOK_ENV_FILE_BYTES + 1)
			const read = readSync(fd, buffer, 0, buffer.length, 0)
			if (read > MAX_HOOK_ENV_FILE_BYTES) {
				this.report(
					`A hook's variables file is longer than ${MAX_HOOK_ENV_FILE_BYTES / 1024} KiB; only the first ${MAX_HOOK_ENV_FILE_BYTES / 1024} KiB is read.`,
				)
			}
			return buffer.subarray(0, Math.min(read, MAX_HOOK_ENV_FILE_BYTES)).toString('utf8')
		} catch {
			return undefined
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd)
				} catch {
					// Nothing more to do with a descriptor that will not close.
				}
			}
		}
	}

	private parse(event: HookEnvEvent, text: string): Map<string, string> {
		const layer = new Map<string, string>()
		const inherited = this.options.inherited?.() ?? process.env
		// An earlier kind of hook's values are visible to `$NAME`, then this file's own so far.
		const lower = new Map<string, string>()
		for (const earlier of HOOK_ENV_EVENTS) {
			if (earlier === event) break
			for (const [name, value] of this.layers.get(earlier) ?? []) lower.set(name, value)
		}
		const lookup = (name: string): string =>
			layer.get(name) ?? lower.get(name) ?? inherited[name] ?? ''
		const lines = text.split(/\r?\n/)
		for (const [index, raw] of lines.entries()) {
			const read = readHookEnvLine(raw, lookup)
			if ('skip' in read) continue
			if ('problem' in read) {
				this.report(
					`A ${event} hook set a variable that was not read (line ${index + 1}): ${read.problem}.`,
				)
				continue
			}
			layer.set(read.ok.name, read.ok.value)
		}
		return layer
	}

	private merge(): void {
		for (const key of Object.keys(this.variables)) delete this.variables[key]
		let count = 0
		for (const event of HOOK_ENV_EVENTS) {
			for (const [name, value] of this.layers.get(event) ?? []) {
				if (!(name in this.variables)) {
					if (count >= MAX_HOOK_ENV_VARIABLES) {
						this.report(
							`Hooks have set more than ${MAX_HOOK_ENV_VARIABLES} variables; the ones past that are left out.`,
						)
						continue
					}
					count += 1
				}
				this.variables[name] = value
			}
		}
	}
}
