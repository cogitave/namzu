/**
 * @namzu/cli shell.
 *
 * `runCli(argv)` is the testable entry point that wires Commander to the
 * command registry, resolves global config + formatter, and maps Commander
 * errors to sysexits-aligned exit codes. The bootstrap in `bin.ts` calls
 * this and exits with the returned code.
 */

import { resolve } from 'node:path'
import { loadOutputSchema } from './output-schema.js'

import { Command, CommanderError, Option } from 'commander'

import { BOOT_EVENT_NAMES, EVENT_NAME_ATTRIBUTE, VERSION as SDK_VERSION } from '@namzu/sdk'

import { acpCommand } from './commands/acp.js'
import { doctorCommand } from './commands/doctor.js'
import { drainCommand } from './commands/drain.js'
import { evalCommand } from './commands/eval.js'
import { execCommand } from './commands/exec.js'
import { historyCommand, providersJSONCommand, skillsJSONCommand } from './commands/host-queries.js'
import { loginCommand, logoutCommand } from './commands/login.js'
import { registerAll } from './commands/registry.js'
import { residentCommand } from './commands/resident.js'
import { scheduleCommand } from './commands/schedule.js'
import { serveCommand } from './commands/serve.js'
import { skillsCommand } from './commands/skills.js'
import { stateCommand } from './commands/state.js'
import type { CommandContext } from './commands/types.js'
import { upgradeCommand } from './commands/upgrade.js'
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
	type ZenCatalogueRefresh,
	startZenCatalogueRefresh,
} from './integrations/providers/zen-catalogue.js'
import { resolveNamzuHome } from './integrations/state/home.js'
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
import { CLI_VERSION } from './version.js'

/** sysexits EX_USAGE — command-line argument error. */
const EX_USAGE = 64

/**
 * Commands that were removed, and what replaced each. Typing one gets
 * commander's unknown-command error and one line naming the replacement.
 */
const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
	run: '`namzu run` was replaced by `namzu exec "<prompt>"`, which takes the same options.',
	'run-stream':
		'`namzu run-stream` was replaced by `namzu exec --json "<prompt>"`, which emits the same events.',
}

/**
 * The commands that open a session, and so refresh the model catalogue in the
 * background when they start. The interactive TUI (`namzu`, `namzu resume`)
 * starts it from `launchInteractiveTui`, once it knows it has a terminal.
 *
 * `drain` belongs here because it continues turns another launch parked, and
 * the model such a turn was on may be one only the live or last-good catalogue
 * carries: continued on the bundled snapshot alone, it would have no wire.
 * `namzu resident run` is matched by its action (`opensSessions`); a
 * background runner (`resident start`) is a forked worker that never passes
 * through here and starts its own refresh.
 */
const CATALOGUE_REFRESH_COMMANDS: ReadonlySet<string> = new Set(['exec', 'acp', 'drain'])

/** Whether the command commander is about to run opens agent sessions. */
export function opensSessions(name: string, args: readonly unknown[]): boolean {
	if (CATALOGUE_REFRESH_COMMANDS.has(name)) return true
	// `resident`'s action is its first operand, exactly as `parseResidentFlags` reads it.
	return name === 'resident' && args[0] === 'run'
}

export interface RunCliOptions {
	/** Argv with the leading `node` + script path, matching `process.argv` shape. */
	readonly argv: readonly string[]
	/**
	 * Exact executable plus arguments for the interactive resume hint. The binary
	 * supplies its absolute Node and entrypoint paths; embedded callers can supply
	 * their own launcher. Omitted callers use `namzu` without guessing from argv.
	 */
	readonly resumeCommand?: readonly [string, ...string[]]
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

	// One background catalogue refresh per launch. Started, never awaited: the
	// handle is all the startup path holds, and the `finally` below cancels it
	// when the command returns, so a launch never waits on it at either end.
	let catalogueRefresh: ZenCatalogueRefresh | undefined
	const beginCatalogueRefresh = (config: NamzuCliConfig): void => {
		if (catalogueRefresh !== undefined || config.modelCatalogueRefresh === false) return
		try {
			catalogueRefresh = startZenCatalogueRefresh({
				home: resolveNamzuHome(),
				// The function, not its current value: see the option's comment.
				log: cliLogger,
			})
		} catch (error) {
			// An unusable NAMZU_HOME is the command's problem to report, not this
			// refresh's: the session runs on the bundled catalogue.
			cliLogger().warn('Zen model catalogue refresh not started', {
				'namzu.zen_catalogue.reason': error instanceof Error ? error.message : String(error),
			})
		}
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
		.option(
			'--output-schema <path>',
			'Constrain TUI answers to a JSON Schema file using native structured output (for exec, pass it after the command)',
		)
		.option('-q, --quiet', 'Suppress non-essential output; also raises the log floor to warn')
		.addOption(
			new Option('-v, --verbose', 'Emit debug-level log records to stderr').conflicts('quiet'),
		)
		.addOption(
			new Option(
				'--log-format <format>',
				'Log record format for exec/drain/TUI-flush output: pretty (default) or json. namzu exec --json always writes json, regardless of this flag.',
			).choices(['pretty', 'json']),
		)
		.option(
			'--dangerously-skip-permissions',
			'Run tools without asking for approval (no permission prompts). Only use in a sandbox or a folder you fully trust.',
		)
		.option('--yolo', 'Alias of --dangerously-skip-permissions.')
		.option(
			'--add-dir <path>',
			'Let the file tools reach another directory this session; repeatable. /add-dir does the same from inside.',
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option(
			'--profile <name>',
			'Apply a named profile from the config files. A name no file declares is refused, not ignored.',
		)
		// Required by Commander 14 so subcommands (doctor) can opt into
		// passThroughOptions for unparsed argument forwarding.
		.hook('preAction', (command, action) => {
			if (command.opts().outputSchema && !['namzu', 'resume'].includes(action.name())) {
				command.error(
					action.name() === 'exec'
						? '--output-schema before the command applies to the interactive TUI; for exec, pass it after: namzu exec --output-schema <file> "<prompt>".'
						: '--output-schema applies to the interactive TUI and to exec, not this subcommand.',
					{
						exitCode: EX_USAGE,
						code: 'commander.invalidArgument',
					},
				)
			}
			if (opensSessions(action.name(), action.args)) {
				beginCatalogueRefresh(getBootstrapContext().config)
			}
		})
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
	let recoveryCtx: CommandContext | null = null
	const getRecoveryContext = (): CommandContext => {
		if (recoveryCtx) return recoveryCtx
		const globalOpts = program.opts<{
			format?: string
			quiet?: boolean
			verbose?: boolean
			logFormat?: string
		}>()
		const format: FormatName = (() => {
			if (globalOpts.format === undefined) return 'text'
			if (isFormatName(globalOpts.format)) return globalOpts.format
			throw new Error(`Commander admitted an invalid --format value: ${globalOpts.format}`)
		})()
		const quiet = globalOpts.quiet ?? false
		const logging: ResolvedLogging = {
			level: resolveLogLevel({
				verbose: globalOpts.verbose,
				quiet: globalOpts.quiet,
			}),
			format: resolveLogFormat({ logFormat: globalOpts.logFormat }),
		}
		// A recovery inventory has to work when ~/.namzu/config.yaml is the
		// damaged object being inspected. It therefore derives presentation only
		// from already-parsed global flags and never enters either config cascade.
		installCliLogging(createStderrSink(logging.format), logging.level)
		recoveryCtx = {
			formatter: createFormatter(format, { quiet }),
			config: { format, quiet },
			logging,
		}
		return recoveryCtx
	}

	// Stopping or inspecting a resident must remain possible with broken config.
	// Its turn action resolves this bridge only after trusting the bound cwd.
	const getResidentContext = () =>
		bindTrustedProjectContext(getRecoveryContext(), getTrustedContext)
	for (const def of [
		acpCommand,
		doctorCommand,
		execCommand,
		residentCommand,
		loginCommand,
		logoutCommand,
		drainCommand,
		evalCommand,
		historyCommand,
		skillsCommand,
		skillsJSONCommand,
		providersJSONCommand,
		upgradeCommand,
		serveCommand,
		stateCommand,
		scheduleCommand,
	]) {
		registerAll(program, [def], {
			getContext:
				def === residentCommand
					? getResidentContext
					: def === stateCommand
						? getRecoveryContext
						: def === acpCommand ||
								def === execCommand ||
								def === drainCommand ||
								def === skillsCommand ||
								def === upgradeCommand ||
								def === scheduleCommand
							? getBootstrapContext
							: getContext,
			setExitCode,
		})
	}

	const launchInteractiveTui = async (initialConversationId?: string): Promise<void> => {
		if (process.stdout.isTTY) {
			const launchOpts = program.opts<{
				dangerouslySkipPermissions?: boolean
				yolo?: boolean
				outputSchema?: string
				addDir?: string[]
			}>()
			const structuredOutput = launchOpts.outputSchema
				? loadOutputSchema(resolve(process.cwd(), launchOpts.outputSchema))
				: undefined
			const skipPermissions = Boolean(launchOpts.dangerouslySkipPermissions || launchOpts.yolo)
			// The same three lines `exec` uses. The TUI compiled
			// nothing at all, so a `permissions` table in a config file did nothing
			// in the mode most people actually use.
			const commandCtx = getBootstrapContext()
			beginCatalogueRefresh(commandCtx.config)
			const buildTuiContext = (resolvedCtx: ResolvedCommandContext, cwd: string) => {
				const permissions = compilePermissions(
					resolvedCtx.config.permissions,
					resolvedCtx.config.permissionChecks,
				)
				for (const d of permissions.diagnostics) {
					const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
					resolvedCtx.formatter.error({ message: `${where}: ${d.message}` })
				}
				const additionalDirectories = [
					...(resolvedCtx.config.additionalDirectories ?? []),
					...(launchOpts.addDir ?? []),
				].map((dir) => resolve(cwd, dir))
				return {
					cwd,
					...(structuredOutput ? { structuredOutput } : {}),
					version: CLI_VERSION,
					configDebug: resolvedCtx.configDebug,
					skipPermissions,
					...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
					rules: permissions.rules,
					logging: resolvedCtx.logging,
					...(initialConversationId ? { initialConversationId } : {}),
					...(resolvedCtx.config.mcpServers ? { mcpServers: resolvedCtx.config.mcpServers } : {}),
					...(resolvedCtx.config.plugins ? { plugins: resolvedCtx.config.plugins } : {}),
					...(resolvedCtx.config.skills ? { skills: resolvedCtx.config.skills } : {}),
					...(resolvedCtx.config.web ? { web: resolvedCtx.config.web } : {}),
					...(resolvedCtx.config.hooks ? { hooks: resolvedCtx.config.hooks } : {}),
					...(resolvedCtx.config.compaction ? { compaction: resolvedCtx.config.compaction } : {}),
					...(resolvedCtx.config.memory ? { memory: resolvedCtx.config.memory } : {}),
					...(resolvedCtx.config.limits ? { limits: resolvedCtx.config.limits } : {}),
					...(resolvedCtx.config.sandbox ? { sandbox: resolvedCtx.config.sandbox } : {}),
					// `!== undefined`, never `??`: an empty list is the operator
					// switching the screens off, and it is the answer this key
					// exists for. A truthiness test would drop it and the turn
					// would install the kernel default instead — the opposite
					// of what was asked for, in the one case the operator was
					// explicit about.
					...(resolvedCtx.config.toolResultScreens !== undefined
						? { toolResultScreens: resolvedCtx.config.toolResultScreens }
						: {}),
					...(resolvedCtx.config.tui ? { tui: resolvedCtx.config.tui } : {}),
				}
			}
			const tuiCtx = buildTuiContext(commandCtx, process.cwd())
			bindTrustedProjectContext(tuiCtx, (cwd) =>
				buildTuiContext(resolveTrustedProjectContext(commandCtx, cwd), cwd),
			)
			const { launchTui } = await import('./tui/index.js')
			const resumeCommand = launchOpts.outputSchema
				? ([
						...(opts.resumeCommand ?? ['namzu']),
						'--output-schema',
						resolve(process.cwd(), launchOpts.outputSchema),
					] as [string, ...string[]])
				: opts.resumeCommand
			if (resumeCommand) await launchTui(tuiCtx, { resumeCommand })
			else await launchTui(tuiCtx)
			const code = await Promise.resolve(0)
			setExitCode(code)
			return
		}
		process.stdout.write(
			'namzu — interactive TUI requires a terminal. For utility subcommands run `namzu --help`.\n',
		)
	}

	// A copy/pasteable shell address for the durable conversation printed by
	// clean TUI exit. The in-TUI `/resume` picker remains available when an id is
	// not already known.
	program
		.command('resume')
		.description('Resume an interactive conversation by its durable id')
		.argument('<conversation-id>', 'Conversation id printed when the TUI exited')
		.action(async (conversationId: string) => {
			// Conversations are stored per folder. A scheduled run's id resumed
			// from elsewhere would only be "not found"; say where it lives.
			const { scheduledSessionElsewhere } = await import('./schedule/resume-command.js')
			const elsewhere = scheduledSessionElsewhere(resolveNamzuHome(), conversationId, process.cwd())
			if (elsewhere) {
				process.stderr.write(
					`namzu: ${conversationId} is a run of the scheduled job ${elsewhere.job.name}, and its conversation is stored with the job's folder, ${elsewhere.job.folder.canonical}. Open it there:\n  ${elsewhere.command}\n`,
				)
				setExitCode(EX_USAGE)
				return
			}
			await launchInteractiveTui(conversationId)
		})

	// Default behavior when `namzu` is invoked with no subcommand: launch
	// the TUI (M3). When stdout is not a TTY (tests, pipes, CI), print a
	// one-line marker instead so the binary stays scriptable and our test
	// suite does not try to render Ink against a non-tty stream.
	program.action(async () => {
		await launchInteractiveTui()
	})

	try {
		// Checked before commander parses, because commander answers `--help`
		// before it looks at the operands: `namzu run --help` would otherwise
		// print the root help and exit 0 without naming what replaced `run`.
		const removed = firstRootOperand(program, opts.argv.slice(2))
		const hint = removed !== undefined ? REMOVED_COMMANDS[removed] : undefined
		if (removed !== undefined && hint !== undefined) {
			program.error(`error: unknown command '${removed}'\n${hint}`, {
				exitCode: EX_USAGE,
				code: 'commander.unknownCommand',
			})
		}
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
	} finally {
		catalogueRefresh?.cancel()
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
	// attribute value for a secret shape, the SAME defence `namzu exec`'s
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
			// The BOOLEAN only. The disclosure sentence is emitted by `exec` at the
			// moment export is actually attached, under this same event name,
			// because that sentence describes what was BUILT — the destination
			// that resolved, the redactors that loaded — and this function is
			// synchronous by design: `doctor` and `login` call it before anything
			// async has happened, and neither of them attaches an export at all.
			'namzu.telemetry.session_export': config.telemetry?.sessionExport !== undefined,
		},
	)
}

/**
 * The first operand the root command would see in `args`, read the way
 * commander reads it: root options and their values are skipped, `-h` and
 * `--help` are flags, and an unknown option or `--` ends the search, because
 * after either commander stops treating what follows as a command name.
 */
function firstRootOperand(program: Command, args: readonly string[]): string | undefined {
	const takesValue = (flag: string): boolean | undefined => {
		if (flag === '-h' || flag === '--help') return false
		const option = program.options.find((o) => o.long === flag || o.short === flag)
		if (option === undefined) return undefined
		return option.required || option.optional
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		if (arg === '--') return undefined
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=')
			const value = takesValue(eq === -1 ? arg : arg.slice(0, eq))
			if (value === undefined) return undefined
			if (value && eq === -1) i++
			continue
		}
		if (arg.length > 1 && arg.startsWith('-')) {
			const value = takesValue(arg.slice(0, 2))
			if (value === undefined) return undefined
			if (value && arg.length === 2) i++
			continue
		}
		return arg
	}
	return undefined
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
