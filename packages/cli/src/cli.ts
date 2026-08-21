/**
 * @namzu/cli shell.
 *
 * `runCli(argv)` is the testable entry point that wires Commander to the
 * command registry, resolves global config + formatter, and maps Commander
 * errors to sysexits-aligned exit codes. The bootstrap in `bin.ts` calls
 * this and exits with the returned code.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command, CommanderError, Option } from 'commander'

import { BOOT_EVENT_NAMES, EVENT_NAME_ATTRIBUTE, VERSION as SDK_VERSION } from '@namzu/sdk'

import { acpCommand } from './commands/acp.js'
import { doctorCommand } from './commands/doctor.js'
import { drainCommand } from './commands/drain.js'
import { evalCommand } from './commands/eval.js'
import { loginCommand, logoutCommand } from './commands/login.js'
import { registerAll } from './commands/registry.js'
import {
	historyCommand,
	providersJSONCommand,
	runStreamCommand,
	skillsJSONCommand,
} from './commands/run-stream.js'
import { runCommand } from './commands/run.js'
import { stubCommands } from './commands/stubs.js'
import type { CommandContext } from './commands/types.js'
import {
	type ConfigDebugSnapshot,
	createConfigDebugSnapshot,
	formatConfigSource,
} from './config/debug.js'
import {
	ConfigLoadError,
	type ConfigProvenance,
	type ConfigSource,
	ConfigValueError,
	loadBootstrapConfigWithProvenance,
	loadConfigWithProvenance,
} from './config/load.js'
import type { NamzuCliConfig } from './config/schema.js'
import {
	bindTrustedProjectContext,
	resolveTrustedProjectContext,
} from './config/trusted-project-context.js'
import { EXIT_BAD_CONFIG, EXIT_INTERNAL_ERROR } from './exit-codes.js'
import {
	cliLogger,
	createStderrSink,
	installCliLogging,
	resolveLogFormat,
	resolveLogLevel,
} from './logging.js'
import type { ResolvedLogging } from './logging.js'
import { type FormatName, createFormatter, isFormatName } from './output/index.js'
import { compilePermissions } from './permissions/rules.js'

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

/** Extra process-owned context that command plugins do not need to know about. */
interface ResolvedCommandContext extends CommandContext {
	readonly configDebug: ConfigDebugSnapshot
	readonly logging: ResolvedLogging
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
		.addOption(
			new Option('-f, --format <type>', 'Output format: text, json, yaml').choices([
				'text',
				'json',
				'yaml',
			]),
		)
		.option('-q, --quiet', 'Suppress non-essential output; also raises the log floor to warn')
		.addOption(
			new Option('-v, --verbose', 'Emit debug-level log records to stderr').conflicts('quiet'),
		)
		.addOption(
			new Option(
				'--log-format <format>',
				'Log record format for run/drain/TUI-flush output: pretty (default) or json. namzu run-stream always writes json, regardless of this flag.',
			).choices(['pretty', 'json']),
		)
		.option(
			'--dangerously-skip-permissions',
			'Run tools without asking for approval (no permission prompts). Only use in a sandbox or a folder you fully trust.',
		)
		.option('--yolo', 'Alias of --dangerously-skip-permissions.')
		.option(
			'--profile <name>',
			'Apply a named profile from the config files. A name no file declares is refused, not ignored.',
		)
		// Required by Commander 14 so subcommands (doctor) can opt into
		// passThroughOptions for unparsed argument forwarding.
		.enablePositionalOptions(true)
		.exitOverride()
		.showHelpAfterError(false)

	const buildContext = (
		load: () => ReturnType<typeof loadConfigWithProvenance>,
	): ResolvedCommandContext => {
		const globalOpts = program.opts<{
			format?: string
			quiet?: boolean
			verbose?: boolean
			logFormat?: string
			profile?: string
		}>()
		const { config: fileConfig, provenance } = load()
		const cliFormat: FormatName | undefined = (() => {
			if (globalOpts.format === undefined) return undefined
			if (isFormatName(globalOpts.format)) return globalOpts.format
			// Commander's enumerated option owns the operator-facing refusal. This
			// branch is an invariant check so removing `.choices(...)` cannot bring
			// back the old silent fallback.
			throw new Error(`Commander admitted an invalid --format value: ${globalOpts.format}`)
		})()
		const formatFromCli = cliFormat !== undefined
		const format: FormatName = cliFormat ?? fileConfig.format ?? 'text'
		const quiet = globalOpts.quiet ?? fileConfig.quiet ?? false
		const envProfile = process.env.NAMZU_PROFILE
		const selectedProfile =
			globalOpts.profile !== undefined && globalOpts.profile !== ''
				? { name: globalOpts.profile, selectedBy: '--profile' as const }
				: globalOpts.profile === undefined && envProfile !== undefined && envProfile !== ''
					? { name: envProfile, selectedBy: 'NAMZU_PROFILE' as const }
					: undefined
		const configDebug = createConfigDebugSnapshot(provenance, {
			formatFromCli,
			quietFromCli: globalOpts.quiet !== undefined,
			...(selectedProfile ? { selectedProfile } : {}),
		})
		// Resolved from the ACTUAL parsed flags, not `quiet` above — that value
		// already folds in NAMZU_QUIET and a config file's `quiet: true`.
		// "Flag beats env" (LOG-05) means the literal --verbose/--quiet on THIS
		// command line beats NAMZU_LOG_LEVEL; widening it to every source that
		// can produce `quiet: true` would let NAMZU_QUIET silently override an
		// operator's own NAMZU_LOG_LEVEL, which neither variable promises.
		const logging: ResolvedLogging = {
			level: resolveLogLevel({
				verbose: globalOpts.verbose,
				quiet: globalOpts.quiet,
			}),
			format: resolveLogFormat({ logFormat: globalOpts.logFormat }),
		}
		return {
			formatter: createFormatter(format, { quiet }),
			config: { ...fileConfig, format, quiet },
			configDebug,
			logging,
		}
	}

	const selectedConfigOpts = (
		cwd?: string,
	): { readonly profile?: string; readonly cwd?: string } => {
		const profile = program.opts<{ profile?: string }>().profile
		return {
			...(profile !== undefined ? { profile } : {}),
			...(cwd !== undefined ? { cwd } : {}),
		}
	}
	let bootstrapCtx: ResolvedCommandContext | null = null
	const trustedContexts = new Map<string, ResolvedCommandContext>()
	const getTrustedContext = (cwd: string): ResolvedCommandContext => {
		const target = resolve(cwd)
		const cached = trustedContexts.get(target)
		if (cached) return cached
		const loaded = loadConfigWithProvenance(selectedConfigOpts(target))
		const trusted = buildContext(() => loaded)
		emitBootNarrative(loaded.provenance, loaded.config)
		trustedContexts.set(target, trusted)
		return trusted
	}
	const getBootstrapContext = (): ResolvedCommandContext => {
		if (bootstrapCtx) return bootstrapCtx
		const loaded = loadBootstrapConfigWithProvenance(selectedConfigOpts())
		const bootstrap = buildContext(() => loaded)
		// Claim stderr before any handler can log. A later TUI launch replaces
		// this with its ring sink; trusted project activation deliberately does
		// not replace that owner.
		installCliLogging(createStderrSink(bootstrap.logging.format), bootstrap.logging.level)
		bootstrapCtx = bindTrustedProjectContext(bootstrap, getTrustedContext)
		return bootstrapCtx
	}
	const getContext = (): ResolvedCommandContext => {
		getBootstrapContext()
		return getTrustedContext(process.cwd())
	}

	for (const def of [
		acpCommand,
		doctorCommand,
		runCommand,
		loginCommand,
		logoutCommand,
		drainCommand,
		evalCommand,
		runStreamCommand,
		historyCommand,
		skillsJSONCommand,
		providersJSONCommand,
		...stubCommands,
	]) {
		registerAll(program, [def], {
			getContext:
				def === acpCommand || def === runCommand || def === runStreamCommand || def === drainCommand
					? getBootstrapContext
					: getContext,
			setExitCode,
		})
	}

	// Default behavior when `namzu` is invoked with no subcommand: launch
	// the TUI (M3). When stdout is not a TTY (tests, pipes, CI), print a
	// one-line marker instead so the binary stays scriptable and our test
	// suite does not try to render Ink against a non-tty stream.
	program.action(async () => {
		if (process.stdout.isTTY) {
			const launchOpts = program.opts<{
				dangerouslySkipPermissions?: boolean
				yolo?: boolean
			}>()
			const skipPermissions = Boolean(launchOpts.dangerouslySkipPermissions || launchOpts.yolo)
			// The same three lines `run` and `run-stream` use. The TUI compiled
			// nothing at all, so a `permissions` table in a config file did nothing
			// in the mode most people actually use.
			const commandCtx = getBootstrapContext()
			const buildTuiContext = (resolvedCtx: ResolvedCommandContext, cwd: string) => {
				const permissions = compilePermissions(
					resolvedCtx.config.permissions,
					resolvedCtx.config.permissionChecks,
				)
				for (const d of permissions.diagnostics) {
					const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
					resolvedCtx.formatter.error({ message: `${where}: ${d.message}` })
				}
				return {
					cwd,
					version: CLI_VERSION,
					configDebug: resolvedCtx.configDebug,
					skipPermissions,
					rules: permissions.rules,
					logging: resolvedCtx.logging,
					...(resolvedCtx.config.mcpServers ? { mcpServers: resolvedCtx.config.mcpServers } : {}),
					...(resolvedCtx.config.sandbox ? { sandbox: resolvedCtx.config.sandbox } : {}),
					...(resolvedCtx.config.tui ? { tui: resolvedCtx.config.tui } : {}),
				}
			}
			const tuiCtx = buildTuiContext(commandCtx, process.cwd())
			bindTrustedProjectContext(tuiCtx, (cwd) =>
				buildTuiContext(resolveTrustedProjectContext(commandCtx, cwd), cwd),
			)
			const { launchTui } = await import('./tui/index.js')
			await launchTui(tuiCtx)
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
		// A config file the operator can fix. The message names the file and
		// what is wrong with it; a stack trace would only point at the reader
		// that noticed, which is not where the problem is.
		if (err instanceof ConfigLoadError) {
			process.stderr.write(
				`${err.message}\nnamzu will not start with a config it cannot read. Fix the file or remove it.\n`,
			)
			return EXIT_BAD_CONFIG
		}
		if (err instanceof ConfigValueError) {
			const remediation =
				err.source.kind === 'file'
					? 'Fix the named setting or remove it from that file.'
					: `Fix or unset ${err.source.variable}.`
			process.stderr.write(
				`${err.message}\nnamzu will not start with an explicit config value it cannot honour. ${remediation}\n`,
			)
			return EXIT_BAD_CONFIG
		}
		process.stderr.write(
			`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		return EXIT_INTERNAL_ERROR
	}
}

/**
 * The CLI-process third of the boot narrative — the two other thirds
 * (`namzu.sandbox.resolved`/`.provider.resolved`/`.capability.*`/
 * `.discovery.completed`/`.boot.ready`, and the SDK's own
 * `namzu.migration.completed`) belong to `createAgentSession`
 * (`tui/agent.ts`) and `query()` respectively, because they describe facts
 * an agent session resolves — `doctor` and `login` never reach either.
 *
 * Exported (not re-exported from `./index.ts`) so `__tests__/` can drive it
 * directly with a hand-built `ConfigProvenance` and a capturing sink,
 * without needing a live Commander parse or a real config cascade on disk.
 */
export function emitBootNarrative(provenance: ConfigProvenance, config: NamzuCliConfig): void {
	const log = cliLogger()
	log.info('namzu starting', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.BOOT_START,
		'namzu.boot.cli_version': CLI_VERSION,
		'namzu.boot.sdk_version': SDK_VERSION,
		'namzu.boot.node_version': process.version,
		'namzu.boot.platform': `${process.platform}-${process.arch}`,
	})

	const counts: Record<ConfigSource['kind'], number> = {
		default: 0,
		'user-file': 0,
		'project-file': 0,
		profile: 0,
		env: 0,
		managed: 0,
	}
	for (const source of Object.values(provenance)) {
		if (source) counts[source.kind]++
	}
	const keyCount = Object.keys(provenance).length
	log.info('Configuration resolved', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED,
		'namzu.config.key_count': keyCount,
		'namzu.config.default_count': counts.default,
		'namzu.config.user_file_count': counts['user-file'],
		'namzu.config.project_file_count': counts['project-file'],
		'namzu.config.env_count': counts.env,
	})
	// Per-key debug rows. The value is handed to the logger as JSON text, not
	// hand-masked by key name and not omitted — the record-boundary
	// redaction scan every sink sits behind
	// (`packages/sdk/src/utils/log/redact.ts`) already screens every
	// attribute value for a secret shape, the SAME defence `namzu run`'s
	// stderr gets. A second, bespoke "these key names are secret" table
	// here would duplicate that control and go stale the day a
	// secret-shaped value arrives under a key nobody added to it — exactly
	// the empty, undriven masking table this session already struck once.
	for (const key of Object.keys(provenance) as (keyof NamzuCliConfig)[]) {
		const source = provenance[key]
		if (!source) continue
		log.debug('config key resolved', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CONFIG_RESOLVED,
			'namzu.config.key': key,
			'namzu.config.value': JSON.stringify((config as Record<string, unknown>)[key]),
			'namzu.config.source': formatConfigSource(source),
		})
	}

	// The CLI never calls `registerTelemetry()` on any path today — this is
	// therefore not a probe, it is the honest constant truth of the process
	// that is running. §3.3's falsifiable claim ("every record inside an
	// active span carries traceId/spanId") is what this line resolves the
	// ambiguity for: absence of a trace id reads as "off", stated here,
	// never silently as "dropped".
	log.info(
		'no LoggerProvider/TracerProvider registered; trace_id will be absent from every record this process emits',
		{
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.TELEMETRY_STATUS,
			'namzu.telemetry.registered': false,
			// Session CONTENT export, which is a different question from whether
			// a tracer is registered and is the one an end user cares about: this
			// is the flag that says whether their conversation leaves the machine.
			// Always present, so "off" is a stated fact rather than the absence
			// of a claim.
			//
			// The BOOLEAN only. The disclosure sentence is emitted by `run` at the
			// moment export is actually attached, under this same event name,
			// because that sentence describes what was BUILT — the destination
			// that resolved, the redactors that loaded — and this function is
			// synchronous by design: `doctor` and `login` call it before anything
			// async has happened, and neither of them attaches an export at all.
			'namzu.telemetry.session_export': config.telemetry?.sessionExport !== undefined,
		},
	)
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
		case 'commander.conflictingOption':
			return EX_USAGE
		default:
			return EXIT_INTERNAL_ERROR
	}
}
