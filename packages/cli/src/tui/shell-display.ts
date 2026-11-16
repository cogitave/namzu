/**
 * A shell command as a person reads it on screen.
 *
 * The model often starts a command with `cd <the working folder> && `, which says nothing the
 * screen has not said: every command already runs there. Leaving it out of the rows and the
 * permission prompt keeps the command itself in view. A `cd` anywhere else is kept, since it
 * changes what the rest of the line does.
 */

import { resolve } from 'node:path'

const LEADING_CD = /^\s*cd\s+(?:--\s+)?("(?:[^"\\]|\\.)*"|'[^']*'|[^\s&;|<>()]+)\s*(?:&&|;)\s*/u

function unquote(word: string): string {
	if (word.startsWith('"') && word.endsWith('"')) return word.slice(1, -1).replace(/\\(.)/gu, '$1')
	if (word.startsWith("'") && word.endsWith("'")) return word.slice(1, -1)
	return word
}

/**
 * `command` without a leading `cd <cwd> &&` (or `;`) when that folder is `cwd` itself. The rest of
 * the line comes back as written; a command that is nothing but the `cd`, or that goes elsewhere,
 * is returned unchanged.
 */
export function withoutCdToCwd(command: string, cwd: string | undefined): string {
	if (cwd === undefined) return command
	const match = LEADING_CD.exec(command)
	if (!match) return command
	const rest = command.slice(match[0].length)
	if (rest.trim().length === 0) return command
	const target = unquote(match[1] as string)
	// `~` and variables are the shell's to expand: only a path that can be read as written is compared.
	if (target.startsWith('~') || target.includes('$') || target.includes('`')) return command
	return resolve(cwd, target) === resolve(cwd) ? rest : command
}

/** Where each top-level word of a command starts and ends: quotes and escapes keep a word whole. */
function words(command: string): Array<{ readonly start: number; readonly end: number }> {
	const out: Array<{ start: number; end: number }> = []
	let start = -1
	let quote: '"' | "'" | null = null
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string
		if (quote) {
			if (char === '\\' && quote === '"') i++
			else if (char === quote) quote = null
			continue
		}
		if (char === ' ') {
			if (start >= 0) out.push({ start, end: i })
			start = -1
			continue
		}
		if (start < 0) start = i
		if (char === '"' || char === "'") quote = char
		else if (char === '\\') i++
	}
	if (start >= 0) out.push({ start, end: command.length })
	return out
}

const OPERATORS = new Set(['&&', '||', '|', ';', '&'])

/**
 * A one-line command cut to `limit` characters at a word of the command, never inside a quoted
 * string, and never leaving the start of a step it does not show. A command that fits comes back whole;
 * one that does not ends with ` …`, after the last whole word that fits. Only a first word longer
 * than the room is cut inside.
 */
export function fitCommand(command: string, limit: number): string {
	if (command.length <= limit) return command
	const room = Math.max(1, limit - 2)
	const fitting = words(command).filter((word) => word.end <= room)
	// Prefer whole steps: with an operator among the words that fit, the line ends before the last
	// one, so it never shows the start of a step it cuts.
	let operator = fitting.length - 1
	while (
		operator >= 0 &&
		!OPERATORS.has(command.slice(fitting[operator]?.start, fitting[operator]?.end))
	)
		operator--
	if (operator > 0) fitting.length = operator
	const last = fitting.at(-1)
	if (!last) return `${command.slice(0, Math.max(1, limit - 1))}…`
	return `${command.slice(0, last.end)} …`
}
