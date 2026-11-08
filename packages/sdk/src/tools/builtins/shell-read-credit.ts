import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

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
	{ readonly valued: ReadonlySet<string>; readonly script?: true }
> = new Map([
	['cat', { valued: new Set() }],
	['head', { valued: new Set(['-n', '-c']) }],
	['tail', { valued: new Set(['-n', '-c']) }],
	['nl', { valued: new Set(['-b', '-n', '-w', '-s']) }],
	['tac', { valued: new Set(['-s']) }],
	['less', { valued: new Set() }],
	['more', { valued: new Set() }],
	['bat', { valued: new Set(['-r', '-l', '--line-range', '--language']) }],
	['rev', { valued: new Set() }],
	['sed', { valued: new Set(['-e', '-f']), script: true }],
	['awk', { valued: new Set(['-F', '-v', '-f']), script: true }],
])

const MAX_CREDITED_FILES = 8
const MAX_CREDITED_BYTES = 2 * 1024 * 1024

/**
 * The literal file operands the line shows, in order. Empty for a sandboxed
 * turn (the ledger's keys there are sandbox paths) and for any line that
 * cannot be read completely.
 */
export function shellShownFiles(line: string, sandboxed: boolean): string[] {
	if (sandboxed || line.trim() === '') return []
	const lexed = lexShellCommandLine(line)
	if (!lexed.complete || lexed.opaque) return []
	// A directory change anywhere in the line moves what later operands mean.
	if (
		lexed.commands.some((c) =>
			['cd', 'pushd', 'popd'].includes(c.words[c.assignments]?.value ?? ''),
		)
	) {
		return []
	}
	const files: string[] = []
	for (const command of lexed.commands) {
		if (command.origin !== 'line') continue
		const words = command.words.slice(command.assignments)
		const head = words[0]
		if (head === undefined || head.expands || head.quoted) continue
		const printer = PRINTERS.get(head.value)
		if (printer === undefined) continue
		const operands: string[] = []
		let inPlace = false
		let scriptGiven = false
		let optionsEnded = false
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
				if (printer.valued.has(value)) i += 1
				continue
			}
			operands.push(word.expands || word.substitutes ? '' : value)
		}
		if (inPlace) continue
		// `sed` and `awk` take the script first unless it was given by an option.
		if (printer.script && !scriptGiven) operands.shift()
		for (const operand of operands) {
			if (operand === '' || operand === '-' || operand.startsWith('~')) continue
			files.push(operand)
		}
	}
	return files
}

/**
 * Put the files a successful command showed on the session's read ledger, with
 * their whole current body, as a windowed `read` does. A file that cannot be
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
	let shown: string[]
	try {
		shown = shellShownFiles(command, context.sandbox !== undefined)
	} catch {
		return
	}
	for (const operand of [...new Set(shown)].slice(0, MAX_CREDITED_FILES)) {
		try {
			const absolute = isAbsolute(operand) ? operand : resolve(startDirectory, operand)
			const key = await resolveWithinAnyReal(toolRoots(context), absolute)
			const info = await stat(key)
			if (!info.isFile() || info.size > MAX_CREDITED_BYTES) continue
			tracker.recordRead(key, await readFile(key, 'utf-8'))
		} catch {
			// Missing, unreadable or outside the roots: not a read.
		}
	}
}
