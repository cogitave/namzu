/**
 * A service named on the command line: `schedule service status <name>` and
 * `--service <name>` on the job commands. The name is looked up in the index
 * and the command then runs with that service's home, exactly as if
 * `NAMZU_HOME` were set to it: `--home` is appended (every verb honours it
 * over the environment) and `NAMZU_HOME` is set for the call.
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandContext } from '../../commands/types.js'
import { EXIT_USAGE } from '../../exit-codes.js'
import { type ServiceIndexEntry, readServiceIndexChecked } from './registry.js'

export interface ServiceTarget {
	readonly name: string
	readonly home: string
	readonly entry: ServiceIndexEntry
}

export interface Targeted {
	/** The arguments with the target word or `--service` removed and `--home` added. */
	readonly argv: string[]
	readonly target?: ServiceTarget
	/** Put `NAMZU_HOME` back. */
	restore(): void
}

function pull(argv: readonly string[], mode: 'word' | 'flag'): { name?: string; rest: string[] } {
	if (mode === 'word') {
		const first = argv[0]
		return first !== undefined && !first.startsWith('--')
			? { name: first, rest: argv.slice(1) }
			: { rest: [...argv] }
	}
	const rest: string[] = []
	let name: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (arg === '--service' && i + 1 < argv.length) name = argv[++i]
		else if (arg.startsWith('--service=')) name = arg.slice('--service='.length)
		else rest.push(arg)
	}
	return { ...(name !== undefined ? { name } : {}), rest }
}

/**
 * Resolve the target of `argv`. `word`: the first argument, when it is not a
 * flag (service commands). `flag`: `--service <name>` anywhere (job commands).
 * `needsHome`: refuse a service whose home folder is gone (job commands).
 * An error has been printed when `code` is returned.
 */
export function applyTarget(
	ctx: CommandContext,
	argv: readonly string[],
	mode: 'word' | 'flag',
	needsHome: boolean,
): Targeted | { code: number } {
	const { name, rest } = pull(argv, mode)
	if (name === undefined) return { argv: rest, restore: () => undefined }
	const index = readServiceIndexChecked()
	const entry = index.services.find((e) => e.name === name)
	if (!entry) {
		if (index.problem) {
			ctx.formatter.error({ message: `cannot look up ${name}: ${index.problem}` })
			return { code: 1 }
		}
		const known = index.services.map((e) => e.name)
		ctx.formatter.error({
			message: `no scheduler service is named ${name}; ${
				known.length > 0 ? `known: ${known.join(', ')}; ` : 'none is installed; '
			}see namzu schedule service list`,
		})
		return { code: EXIT_USAGE }
	}
	const home = resolve(entry.home)
	if (needsHome && !existsSync(home)) {
		ctx.formatter.error({ message: `service ${name} serves ${home}, which no longer exists` })
		return { code: 1 }
	}
	ctx.formatter.info(`Using the scheduler service ${name} (${home}).`)
	const current = process.env.NAMZU_HOME
	if (current !== undefined && current.length > 0 && resolve(current) !== home)
		ctx.formatter.info(`NAMZU_HOME points at ${current}; the service name wins.`)
	const usable = existsSync(home) && statSync(home).isDirectory()
	if (usable) process.env.NAMZU_HOME = home
	return {
		argv: [...rest, '--home', home],
		target: { name, home, entry },
		restore: () => {
			if (!usable) return
			if (current === undefined) Reflect.deleteProperty(process.env, 'NAMZU_HOME')
			else process.env.NAMZU_HOME = current
		},
	}
}
