/**
 * What a shell line reaches that no rule and no skill grant may approve in
 * advance, asked outside a turn. The executor asks the same questions of a
 * nested call (`escalationOf`); a host that runs a command without an
 * executor (a command a person typed, a headless prompt) asks them here, so
 * the two routes refuse the same lines.
 */

import { unknownProgramInLine } from '../../authorization/program.js'
import type { ShellDialect } from '../../authorization/shell-lexer.js'
import { shellEscalations } from './path-escalation.js'

export interface ShellLineEscalationContext {
	/** The working directory first, then the added directories. */
	readonly roots: readonly string[]
	/** Where the line starts, when that is not the first root. */
	readonly cwd?: string
	/** Whether the line runs in a sandbox (paths there are the guest's). */
	readonly sandboxed: boolean
	readonly dialect?: ShellDialect
}

/**
 * The reason a shell line must go to a person, or `undefined` when it reaches
 * nothing past the roots. A check that throws is answered as an unfinished
 * check, never as "nothing found".
 */
export async function shellLineEscalation(
	line: string,
	context: ShellLineEscalationContext,
): Promise<string | undefined> {
	const dialect = context.dialect ?? 'sh'
	try {
		const found = await shellEscalations(line, dialect, {
			roots: context.roots,
			...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
			reviewOutside: !context.sandboxed,
			topLevel: !context.sandboxed,
		})
		if (found.protectedPaths.length > 0) return 'it writes to a protected path'
		if (found.dangerousRemoval !== undefined) return 'it removes more than a command may'
		if (found.outsidePaths.length > 0) return 'it reaches outside the working folders'
		if (unknownProgramInLine(line, dialect) !== undefined)
			return 'it runs a program Namzu cannot read'
		return undefined
	} catch {
		return 'the safety checks did not finish'
	}
}
