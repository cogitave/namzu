/**
 * @namzu/cli shell.
 *
 * `runCli(argv)` is the testable entry point that wires Commander to the
 * command registry, resolves global config + formatter, and maps Commander
 * errors to sysexits-aligned exit codes. The bootstrap in `bin.ts` calls
 * this and exits with the returned code.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command, CommanderError } from 'commander'

import { doctorCommand } from './commands/doctor.js'
import { providersCommand } from './commands/providers.js'
import { registerAll } from './commands/registry.js'
import { runCommand } from './commands/run.js'
import { stubCommands } from './commands/stubs.js'
import { toolsCommand } from './commands/tools.js'
import type { CommandContext } from './commands/types.js'
import { loadConfig } from './config/load.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'
import { type FormatName, createFormatter, isFormatName } from './output/index.js'

/** sysexits EX_USAGE — command-line argument error. */
const EX_USAGE = 64

// Read the version straight from the package manifest so the `--version`
// output cannot drift from what Changesets publishes. Works both for the
// compiled `dist/cli.js` and for `tsx src/cli.ts` (both sit one dir below
// the package root).
const CLI_VERSION: string = readPackageVersion()

function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkgPath = join(here, '..', 'package.json')
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

export interface RunCliOptions {
	/** Argv with the leading `node` + script path, matching `process.argv` shape. */
	readonly argv: readonly string[]
}

export async function runCli(opts: RunCliOptions): Promise<number> {
	let exitCode = 0
	const setExitCode = (code: number): void => {
		exitCode = code
	}

	const program = new Command()
		.name('namzu')
		.description('Operator CLI for the Namzu agent platform')
		.version(CLI_VERSION, '-V, --version', 'Print version and exit')
		.option('-f, --format <type>', 'Output format: text, json, yaml')
		.option('-q, --quiet', 'Suppress non-essential output')
		.option(
			'--dangerously-skip-permissions',
			'Run tools without asking for approval (no permission prompts). Only use in a sandbox or a folder you fully trust.',
		)
		.option('--yolo', 'Alias of --dangerously-skip-permissions.')
		// Required by Commander 14 so subcommands (doctor) can opt into
		// passThroughOptions for unparsed argument forwarding.
		.enablePositionalOptions(true)
		.exitOverride()
		.showHelpAfterError(false)

	let ctx: CommandContext | null = null
	const getContext = (): CommandContext => {
		if (ctx) return ctx
		const globalOpts = program.opts<{ format?: string; quiet?: boolean }>()
		const fileConfig = loadConfig()
		const format: FormatName =
			globalOpts.format && isFormatName(globalOpts.format)
				? globalOpts.format
				: (fileConfig.format ?? 'text')
		const quiet = globalOpts.quiet ?? fileConfig.quiet ?? false
		ctx = {
			formatter: createFormatter(format, { quiet }),
			config: { ...fileConfig, format, quiet },
		}
		return ctx
	}

	registerAll(
		program,
		[doctorCommand, toolsCommand, providersCommand, runCommand, ...stubCommands],
		{
			getContext,
			setExitCode,
		},
	)

	// Default behavior when `namzu` is invoked with no subcommand: launch
	// the TUI (M3). When stdout is not a TTY (tests, pipes, CI), print a
	// one-line marker instead so the binary stays scriptable and our test
	// suite does not try to render Ink against a non-tty stream.
	program.action(async () => {
		if (process.stdout.isTTY) {
			const launchOpts = program.opts<{ dangerouslySkipPermissions?: boolean; yolo?: boolean }>()
			const skipPermissions = Boolean(launchOpts.dangerouslySkipPermissions || launchOpts.yolo)
			const { launchTui } = await import('./tui/index.js')
			await launchTui({ cwd: process.cwd(), version: CLI_VERSION, skipPermissions })
			const code = await Promise.resolve(0)
			setExitCode(code)
			return
		}
		process.stdout.write(
			'namzu — interactive TUI requires a terminal. For utility subcommands run `namzu --help`.\n',
		)
	})

	try {
		await program.parseAsync(opts.argv as string[], { from: 'node' })
		return exitCode
	} catch (err) {
		if (err instanceof CommanderError) {
			return mapCommanderError(err)
		}
		process.stderr.write(
			`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		return EXIT_INTERNAL_ERROR
	}
}

function mapCommanderError(err: CommanderError): number {
	switch (err.code) {
		case 'commander.helpDisplayed':
		case 'commander.help':
		case 'commander.version':
			return 0
		case 'commander.unknownCommand':
		case 'commander.unknownOption':
		case 'commander.missingArgument':
		case 'commander.missingMandatoryOptionValue':
		case 'commander.invalidArgument':
		case 'commander.invalidOptionArgument':
		case 'commander.excessArguments':
			return EX_USAGE
		default:
			return EXIT_INTERNAL_ERROR
	}
}
