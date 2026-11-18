import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { lexShellCommandLine } from '../../authorization/shell-lexer.js'
import type { ToolContext } from '../../types/tool/index.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'

/**
 * A shell command that prints a file is a read of it. Without this, a model
 * that looked at a file with `cat` or `sed -n` was refused its first edit as
 * "never read", though the whole body had been in front of it.
 *
 * Only what a line shows literally counts: the operand must be a plain word
 * (no variable, substitution, glob or `~`), and a line that changes directory
 * earns nothing because its later operands are relative to somewhere else.
 */

/** Programs that print the files named on their command line, and what their options take. */
const PRINTERS: ReadonlyMap<
	string,
	{ readonly valued: ReadonlySet<string>; readonly script?: true; readonly partial?: true }
> = new Map([
	['cat', { valued: new Set() }],
	['nl', { valued: new Set(['-b', '-n', '-w', '-s', '-v', '-i', '-l']) }],
	['tac', { valued: new Set(['-s']) }],
	['less', { valued: new Set() }],
	['more', { valued: new Set() }],
	['bat', { valued: new Set(['-r', '-l', '--line-range', '--language']) }],
	['rev', { valued: new Set() }],
	// `head` and `tail` show the start or the end, so what they print is a window.
	['head', { valued: new Set(['-n', '-c']), partial: true }],
	['tail', { valued: new Set(['-n', '-c']), partial: true }],
	['sed', { valued: new Set(['-e', '-f']), script: true }],
])

/** Commands that may share the line with a printer: they change no file. */
const HARMLESS = new Set(['echo', 'printf', 'true', 'pwd', 'ls', 'wc', 'stat', 'file'])

/** `sed -n` scripts that only print lines of the file: `p`, `5p`, `1,40p`, `10,$p`. */
const PRINT_RANGE = /^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/
/** The `sed -n` scripts that print every line. */
const PRINT_ALL = /^(?:p|1,\$p)$/

/** Redirections that write: anything but input and a descriptor duplicated onto a descriptor. */
function writes(r: { operator: string; target: { value: string } }): boolean {
	if (r.operator === '<' || r.operator === '<<' || r.operator === '<<-' || r.operator === '<<<') {
		return false
	}
	if (r.operator === '>&' || r.operator === '<&') return !/^(?:\d+|-)$/.test(r.target.value)
	return true
}

/** One file a line printed. `full` is true only when every line of it was shown. */
export interface ShownFile {
	readonly operand: string
	readonly full: boolean
}

const MAX_CREDITED_FILES = 8
const MAX_CREDITED_BYTES = 2 * 1024 * 1024

/**
 * The literal file operands the line shows, in order, and whether each was
 * shown whole. Empty for a sandboxed turn (the ledger's keys there are sandbox
 * paths) and for any line that cannot be read completely.
 *
 * Every segment of the line must be a printer, a harmless command or a
 * `cd <word>` joined by `&&` (it moves the operands after it). A printer whose
 * output feeds a pipe is a window, since the next command may cut it, and a
 * pipe may end only in another printer.
 */
export function shellShownFiles(line: string, sandboxed: boolean): ShownFile[] {
	if (sandboxed || line.trim() === '') return []
	const lexed = lexShellCommandLine(line)
	if (!lexed.complete || lexed.opaque) return []
	// A line that also writes, or runs anything but a printer, may change the file
	// it prints: the body read afterwards would not be the body shown.
	if (lexed.redirections.some(writes)) return []
	if (lexed.commands.some((c) => c.origin !== 'line')) return []
	// How each command is joined to the next, read from the text between them.
	const joins: string[] = []
	let cursor = 0
	let previousEnd = 0
	const spans: Array<{ start: number; end: number }> = []
	for (const command of lexed.commands) {
		const at = line.indexOf(command.text, cursor)
		if (at < 0) return []
		spans.push({ start: at, end: at + command.text.length })
		if (spans.length > 1) joins.push(line.slice(previousEnd, at).replace(/\s+/g, ''))
		previousEnd = at + command.text.length
		cursor = previousEnd
	}
	if (!/^(?:;|&&|\n)?$/.test(line.slice(previousEnd).replace(/[ \t]+/g, ''))) return []
	for (const join of joins) {
		if (!['', ';', '&&', '|', '\n', ';\n'].includes(join)) return []
	}
	let prefix = ''
	const files: ShownFile[] = []
	for (let index = 0; index < lexed.commands.length; index += 1) {
		const command = lexed.commands[index]
		if (command === undefined) continue
		if (command.redirections.some(writes)) return []
		const words = command.words.slice(command.assignments)
		const head = words[0]
		if (head === undefined) continue
		if (head.expands || head.quoted || head.substitutes) return []
		const next = joins[index]
		const feedsPipe = next === '|'
		const fedByPipe = joins[index - 1] === '|'
		if (head.value === 'cd') {
			const target = words[1]
			// Only `cd <dir> && ...`: after `;` a failed cd would leave the rest in
			// the old directory while this credited the new one.
			if (
				words.length !== 2 ||
				target === undefined ||
				target.expands ||
				target.substitutes ||
				target.value === '' ||
				target.value.startsWith('-') ||
				target.value.startsWith('~') ||
				next !== '&&'
			) {
				return []
			}
			prefix = isAbsolute(target.value) ? target.value : join(prefix, target.value)
			continue
		}
		const printer = PRINTERS.get(head.value)
		if (printer === undefined) {
			if (!HARMLESS.has(head.value)) return []
			if (feedsPipe) return []
			continue
		}
		const operands: string[] = []
		let inPlace = false
		let scriptGiven = false
		let optionsEnded = false
		let ranged = false
		for (let i = 1; i < words.length; i += 1) {
			const word = words[i]
			if (word === undefined) continue
			const value = word.value
			if (!optionsEnded && value === '--') {
				optionsEnded = true
				continue
			}
			if (!optionsEnded && value.startsWith('-') && value.length > 1) {
				if (head.value === 'sed' && /^-[a-zA-Z]*i/.test(value)) inPlace = true
				if (head.value === 'sed' && /^--in-place/.test(value)) inPlace = true
				if (value === '-e' || value === '-f') scriptGiven = true
				if (head.value === 'bat' && /^(?:-r|-l|--line-range)/.test(value)) ranged = true
				if (printer.valued.has(value)) i += 1
				continue
			}
			operands.push(word.expands || word.substitutes ? '' : value)
		}
		if (inPlace) return []
		let whole = printer.partial !== true && !ranged && !feedsPipe
		if (head.value === 'sed') {
			const script = words.slice(1).find((w) => !w.value.startsWith('-'))
			if (
				!words.some((w) => w.value === '-n') ||
				script === undefined ||
				!PRINT_RANGE.test(script.value)
			) {
				return []
			}
			whole = whole && PRINT_ALL.test(script.value)
		}
		// `sed` and `awk` take the script first unless it was given by an option.
		if (scriptGiven) return []
		if (printer.script) operands.shift()
		// With no file operand the program reads its input: nothing was printed from a file.
		if (fedByPipe && operands.length === 0) continue
		for (const operand of operands) {
			if (operand === '' || operand === '-' || operand.startsWith('~')) continue
			files.push({ operand: isAbsolute(operand) ? operand : join(prefix, operand), full: whole })
		}
	}
	return files
}

/**
 * Put the files a successful command showed on the session's read ledger. A
 * file printed whole is recorded as a full body; one printed through `head`,
 * `tail`, a `sed` range or a pipe is recorded as a window, as the `read` tool
 * records a ranged read: enough for `edit`, not a claim that the model saw it all. A file that cannot be
 * resolved inside the roots, is not a regular file, or is large earns nothing,
 * and nothing here can fail the command.
 */
export async function creditShellReads(
	command: string,
	context: ToolContext,
	startDirectory: string,
): Promise<void> {
	const tracker = context.fileReadTracker
	if (!tracker) return
	let shown: ShownFile[]
	try {
		shown = shellShownFiles(command, context.sandbox !== undefined)
	} catch {
		return
	}
	const byOperand = new Map<string, boolean>()
	for (const file of shown) {
		byOperand.set(file.operand, (byOperand.get(file.operand) ?? false) || file.full)
	}
	for (const [operand, full] of [...byOperand].slice(0, MAX_CREDITED_FILES)) {
		try {
			const absolute = isAbsolute(operand) ? operand : resolve(startDirectory, operand)
			const key = await resolveWithinAnyReal(toolRoots(context), absolute)
			const info = await stat(key)
			if (!info.isFile() || info.size > MAX_CREDITED_BYTES) continue
			const content = await readFile(key, 'utf-8')
			if (full && tracker.recordFullBody) tracker.recordFullBody(key, content)
			// A window must not forget a whole body the ledger already holds.
			else if (tracker.fullBody?.(key) !== content) tracker.recordRead(key, content)
		} catch {
			// Missing, unreadable or outside the roots: not a read.
		}
	}
}
