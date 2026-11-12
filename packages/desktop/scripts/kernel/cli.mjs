// Small helpers the kernel commands share: flags, "is this file the program being run", exit codes.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `spec` maps a flag to 'string', 'boolean' or 'list' (repeatable). Returns `{ flags, positional }`.
 * An unknown flag or a flag without its value is an error that names the flag.
 */
export function parseFlags(args, spec) {
	const flags = {}
	const positional = []
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (!arg.startsWith('--')) {
			positional.push(arg)
			continue
		}
		const kind = spec[arg.slice(2)]
		if (!kind) throw new Error(`Unknown option ${arg}.`)
		const name = arg.slice(2)
		if (kind === 'boolean') {
			flags[name] = true
			continue
		}
		const value = args[index + 1]
		if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`)
		index += 1
		if (kind === 'list') {
			flags[name] ??= []
			flags[name].push(value)
		} else flags[name] = value
	}
	return { flags, positional }
}

export function isMain(metaUrl) {
	if (!process.argv[1]) return false
	try {
		return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl))
	} catch {
		return false
	}
}

/** Run a command's main; print its error message (never a stack) and exit 1 on failure. */
export async function runMain(main) {
	try {
		process.exitCode = (await main(process.argv.slice(2))) ?? 0
	} catch (error) {
		process.stderr.write(`${error?.message ?? error}\n`)
		process.exitCode = 1
	}
}
