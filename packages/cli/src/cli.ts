/**
 * @namzu/cli shell.
 *
 * `runCli(argv)` is the testable entry point that wires Commander to the
 * command registry, resolves global config + formatter, and maps Commander
 * errors to sysexits-aligned exit codes. The bootstrap in `bin.ts` calls
 * this and exits with the returned code.
 */

import { resolve } from 'node:path'
import { usesCustomNetwork } from './network/settings.js'
import { formatUsageError } from './usage-error.js'

import { Command, CommanderError, Option } from 'commander'

import { REASONING_EFFORT_LEVELS } from './commands/effort-levels.js'
import {
	acpCommand,
	archiveCommand,
	browserCommand,
	computerCommand,
	configCommand,
	costCommand,
	createLazyPalCommand,
	createLazyWorktreeCommand,
	doctorCommand,
	drainCommand,
	evalCommand,
	execCommand,
	extensionCommand,
	githubCommand,
	historyCommand,
	hooksCommand,
	learnCommand,
	learningCommand,
	loginCommand,
	logoutCommand,
	mcpCommand,
	peersCommand,
	pluginCommand,
	providersCommand,
	scheduleCommand,
	sendCommand,
	serveCommand,
	skillsCommand,
	stateCommand,
	upgradeCommand,
	watchCommand,
	workspacesCommand,
} from './commands/manifest.js'
import { registerCommandOrLazy } from './commands/registry.js'
import type { CommandContext } from './commands/types.js'
import type { ConfigDebugSnapshot } from './config/debug.js'
import { hookSwitch } from './config/hook-layers.js'
import type { LaunchSettingsLayer, loadConfigWithProvenance } from './config/load.js'
import { positiveTokenCount, readModelLaunchEnvironment } from './config/model-environment.js'
import type { NamzuCliConfig } from './config/schema.js'
import {
	bindTrustedProjectContext,
	refreshCachedContext,
	refreshTrustedProjectContext,
	resolveTrustedProjectContext,
} from './config/trusted-project-context.js'
import { debugRequested } from './debug-requested.js'
import { EXIT_BAD_CONFIG, EXIT_INTERNAL_ERROR } from './exit-codes.js'
import type { PullRequestFilter } from './integrations/github/pull-request.js'
import type { ZenCatalogueRefresh } from './integrations/providers/zen-catalogue.js'
import type { ResolvedLogging } from './logging.js'
import { type FormatName, createFormatter, isFormatName } from './output/index.js'
import { PERMISSION_MODE_NAMES } from './permissions/mode-names.js'
import { CLI_VERSION } from './version.js'

/** The root options that only `exec` takes after the command name. */
const PER_RUN_FLAG_KEYS: ReadonlySet<string> = new Set([
	'appendSystemPrompt',
	'systemPrompt',
	'tools',
	'name',
	'mcpConfig',
	'strictMcpConfig',
	'allowedTools',
	'disallowedTools',
	'fallbackModel',
	'maxBudgetUsd',
	'maxOutputTokens',
])

/** A repeatable option's accumulator: each use adds one value. */
function collectFlagValue(value: string, previous: string[] | undefined): string[] {
	return [...(previous ?? []), value]
}

/**
 * The launch options of the interactive session, declared once and added to
 * both the root command and `resume`, so the two cannot drift apart. Commander
 * only recognises a root option before the subcommand name (positional options
 * are on), so `namzu resume --dangerously-skip-permissions <id>` needs `resume` to declare them too.
 * The options that choose a conversation (`--continue`, `--resume`,
 * `--from-pr`) and the first message stay on the root alone.
 */
function addLaunchOptions(command: Command): Command {
	return command
		.option(
			'--output-schema <path>',
			'Constrain TUI answers to a JSON Schema file using native structured output (for exec, pass it after the command)',
		)
		.option(
			'--dangerously-skip-permissions',
			'Start in bypass mode: run tools without asking, except for what always needs a person. Only use in a sandbox or a folder you fully trust.',
		)
		.option(
			'--allow-dangerously-skip-permissions',
			'Let Shift+Tab reach bypass mode, without starting in it.',
		)
		.option(
			'--provider <id>',
			'Start the interactive session on this provider for this launch only; the saved choice is untouched.',
		)
		.option(
			'--account <label>',
			'Start the interactive session on this account for this launch only: a label from /auth, or provider:label. The saved choice is untouched.',
		)
		.option(
			'--model <id>',
			'Start the interactive session on this model for this launch only. With --provider it models that provider; alone it re-models the saved primary.',
		)
		.option(
			'--no-done-gate',
			'Keep the check of edits (tests, lint) before a turn ends off for this launch; it is off unless limits.doneGate is true.',
		)
		.addOption(
			new Option(
				'--max-output-tokens <n>',
				'Output allowance per model call for this launch, including reasoning; overrides NAMZU_MAX_OUTPUT_TOKENS and limits.maxResponseTokens.',
			).argParser((value) => {
				try {
					return positiveTokenCount(value, '--max-output-tokens')
				} catch (error) {
					throw new CommanderError(EX_USAGE, 'commander.invalidArgument', (error as Error).message)
				}
			}),
		)
		.addOption(
			new Option(
				'--effort <level>',
				'Reasoning effort for this launch only. A level the model does not offer is reported and the default stays.',
			).choices(REASONING_EFFORT_LEVELS),
		)
		.addOption(
			new Option(
				'--fast',
				'Start with fast inference on for this launch only (Anthropic and OpenAI models that offer it; billed at a multiple of the standard rate, or a faster use of your plan allowance). Off by default. /fast changes it from inside.',
			),
		)
		.addOption(
			new Option(
				'--permission-mode <mode>',
				'Permission mode for this launch only; wins over --dangerously-skip-permissions. auto lets a second model check each call; bypass runs without asking. /permissions changes it from inside.',
			).choices(PERMISSION_MODE_NAMES),
		)
		.option(
			'--append-system-prompt <text|@file>',
			'Add standing instructions for this launch only; @file reads them from a file. They go after the cached part of the prompt, so the cache is untouched.',
		)
		.option(
			'--system-prompt <text|@file>',
			'Replace Namzu’s own system prompt text for this launch only; @file reads it from a file. Tools, --append-system-prompt, project instructions and memory still apply.',
		)
		.option(
			'--tools <list>',
			'Offer only these tools to the model, e.g. "read edit bash"; "" offers none and "default" offers all. Unlike --allowed-tools this removes tools; it is not a permission rule.',
		)
		.option(
			'-n, --name <name>',
			'Name this conversation; the name shows in /resume and in the terminal title.',
		)
		.option(
			'--bare',
			'Minimal start: no hooks, plugins, project instruction files, saved memory notes, learning, code index, background catalogue refresh or update check. See docs/cli/launch-flags.md.',
		)
		.option(
			'--debug-file <path>',
			'Write every log record, debug level included, to this file; what appears on screen keeps its usual level. The folders of the path are created.',
		)
		.option(
			'--settings <file-or-json>',
			'Add one settings layer for this launch, from a JSON file or an inline JSON object. It wins over your user and project settings and loses to flags.',
		)
		.option(
			'--mcp-config <file-or-json>',
			'Add the tool servers in this JSON file (or inline JSON) for this launch; repeatable.',
			collectFlagValue,
		)
		.option(
			'--strict-mcp-config',
			'Use only the tool servers named by --mcp-config; none of the configured or project ones start.',
		)
		.option(
			'--allowed-tools <list>',
			'Allow these tools without asking for this launch, e.g. "edit bash(git status*)"; repeatable. A deny rule still wins.',
			collectFlagValue,
		)
		.option(
			'--disallowed-tools <list>',
			'Refuse these tools for this launch, e.g. "bash(rm *)"; repeatable.',
			collectFlagValue,
		)
		.option(
			'--fallback-model <provider/model[,…]>',
			'Models to fall over to, in order, when the first cannot answer; replaces the saved fallbacks for this launch.',
			collectFlagValue,
		)
		.option(
			'--add-dir <path>',
			'Let the file tools reach another directory this session; repeatable. /add dir does the same from inside.',
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option(
			'--plugin-dir <path>',
			'Load the plugin in this folder for this launch, without turning plugins on in the configuration; repeatable. It runs the plugin’s code, so name only folders you trust.',
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option(
			'--profile <name>',
			'Apply a named profile from the config files. A name no file declares is refused, not ignored.',
		)
}

/** sysexits EX_USAGE — command-line argument error. */
const EX_USAGE = 64

/**
 * Spellings that were removed, and what replaced each: a command (`run`), a
 * command and its action (`config reset`) or a flag (`--yolo`). Typing one
 * gets one line naming the replacement and exit 64; the old behaviour never
 * runs.
 */
const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
	spaces: '`namzu spaces` is now `namzu workspaces`.',
	e: '`namzu e` is now `namzu exec`.',
	'config reset': '`namzu config reset` is now `namzu config unset`.',
	'--yolo': '`--yolo` is now `--dangerously-skip-permissions`.',
	run: '`namzu run` was replaced by `namzu exec "<prompt>"`, which takes the same options.',
	'run-stream':
		'`namzu run-stream` was replaced by `namzu exec --json "<prompt>"`, which emits the same events.',
	'skills-json': 'This command is now `namzu skills list --json`.',
	'providers-json': 'This command is now `namzu providers list --json`.',
}

/**
 * The commands that open a session, and so refresh the model catalogue in the
 * background when they start. The interactive TUI (`namzu`, `namzu resume`)
 * starts it from `launchInteractiveTui`, once it knows it has a terminal.
 *
 * `drain` belongs here because it continues turns another launch parked, and
 * the model such a turn was on may be one only the live or last-good catalogue
 * carries: continued on the bundled snapshot alone, it would have no wire.
 */
const CATALOGUE_REFRESH_COMMANDS: ReadonlySet<string> = new Set(['exec', 'acp', 'drain'])

/** Whether the command commander is about to run opens agent sessions. */
export function opensSessions(name: string): boolean {
	return CATALOGUE_REFRESH_COMMANDS.has(name)
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
	// The command line after `namzu help ...` is rewritten; what asks for help is read from it.
	let helpArgv: readonly string[] = opts.argv
	// `NAMZU_HOME` as it was, when a help request set it aside (see below).
	let setAsideHome: { readonly value: string } | undefined
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
			catalogueRefresh = runtime().startZenCatalogueRefresh({
				home: runtime().resolveNamzuHome(),
				// The function, not its current value: see the option's comment.
				log: runtime().cliLogger,
			})
		} catch (error) {
			// An unusable NAMZU_HOME is the command's problem to report, not this
			// refresh's: the session runs on the bundled catalogue.
			runtime()
				.cliLogger()
				.warn('Zen model catalogue refresh not started', {
					'namzu.zen_catalogue.reason': error instanceof Error ? error.message : String(error),
				})
		}
	}

	// Spans and metrics to a collector, only when asked for. Started once, on
	// the first resolved config; drained in the `finally` below.
	let otlpExport: ReturnType<typeof import('./cli-runtime.js').startOtlpExport> | undefined
	const beginOtlpExport = (config: NamzuCliConfig): void => {
		if (otlpExport !== undefined) return
		otlpExport = runtime().startOtlpExport({
			config: config.telemetry?.otlp,
			env: process.env,
			serviceVersion: CLI_VERSION,
			warn: (message) => runtime().cliLogger().warn(message),
		})
	}

	// What needs the SDK, loaded by the `preAction` hook the first time a command
	// is really going to run. `namzu --version` and `namzu --help` are answered
	// by commander before any hook, and so never compile it.
	let rt: typeof import('./cli-runtime.js') | undefined
	const runtime = (): typeof import('./cli-runtime.js') => {
		if (rt === undefined) throw new Error('the CLI runtime is used before a command started')
		return rt
	}

	const program = new Command()
		.name('namzu')
		.description('Operator CLI for the Namzu agent platform')
		.argument(
			'[prompt]',
			'First message of the interactive session, sent as a plain prompt (never a slash command). With -p it is answered without opening the session.',
		)
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
		.option('--debug', 'Show technical details when something goes wrong (same as NAMZU_DEBUG=1)')
		.addOption(
			new Option(
				'--log-format <format>',
				'Log record format for exec/drain/TUI-flush output: pretty (default) or json. namzu exec --json always writes json, regardless of this flag.',
			).choices(['pretty', 'json']),
		)
		.option(
			'-p, --print',
			'Answer one prompt and exit, without opening the session: `namzu -p "<prompt>"` is `namzu exec "<prompt>"`. It takes the options of `namzu exec`, such as --output-format text|json|stream-json, --input-format text|stream-json and --max-budget-usd; piped input is read the same way. See `namzu exec --help`.',
		)
		// The print-only options are declared so that using one without -p is
		// refused in one line; with -p they are read by `namzu exec`, not here.
		.addOption(new Option('--output-format <format>', 'Needs -p.').hideHelp())
		.addOption(new Option('--input-format <format>', 'Needs -p.').hideHelp())
		.addOption(new Option('--max-budget-usd <amount>', 'Needs -p.').hideHelp())
		// Already shipped: Namzu Desktop's earlier builds start the CLI with this
		// flag. It keeps working, hidden; `namzu "<text>"` is the spelling to use.
		.addOption(new Option('--message <text>', 'First message; use namzu "<text>".').hideHelp())
		.option('-c, --continue', 'Continue the most recent conversation in this directory.')
		.option(
			'-r, --resume [value]',
			'Resume a conversation by id or exact title; with no value, or a value that matches no title, open the picker (the value pre-filters it).',
		)
		.option(
			'--from-pr [value]',
			'Open the picker with only the conversations linked to a pull request; a number or address narrows it to that one.',
		)
		// Required by Commander 14 so subcommands (doctor) can opt into
		// passThroughOptions for unparsed argument forwarding.
		.hook('preAction', async (command, action) => {
			rt ??= await import('./cli-runtime.js')
			// `namzu resume <flags>`: the launch options given after the subcommand
			// are folded into the root's, which is where the launch reads them. A
			// flag given on both sides is not an error: the one after `resume`
			// wins (a repeatable one adds its values to the root's).
			if (action.name() === 'resume') {
				for (const option of action.options) {
					const key = option.attributeName()
					const source = action.getOptionValueSource(key)
					if (source === undefined || source === 'default') continue
					const given = action.getOptionValue(key)
					const before = command.getOptionValue(key)
					command.setOptionValueWithSource(
						key,
						Array.isArray(given) && Array.isArray(before) ? [...before, ...given] : given,
						source,
					)
				}
			}
			// The proxy and client certificate the environment names, for every
			// request this process makes. Only a machine that sets one pays for
			// loading the HTTP client library.
			if (usesCustomNetwork(process.env)) {
				await (await import('./network/install.js')).installNetwork()
			}
			// `--debug-file`, `--bare` and `--settings` shape every command that reads
			// settings or logs: checked first, so a bad value costs nothing else.
			const launchValues = command.opts<{
				bare?: boolean
				settings?: string
				debugFile?: string
			}>()
			const layers = runtime().launchLayersFor(launchValues)
			if ('error' in layers)
				return command.error(layers.error, {
					exitCode: EX_USAGE,
					code: 'commander.invalidArgument',
				})
			launchLayers = layers.layers
			if (launchValues.debugFile !== undefined) {
				try {
					runtime().openDebugFile(launchValues.debugFile)
				} catch (error) {
					command.error((error as Error).message, {
						exitCode: EX_USAGE,
						code: 'commander.invalidArgument',
					})
				}
			}
			const launchOnly = (
				[
					'provider',
					'model',
					'effort',
					'fast',
					'permissionMode',
					'message',
					'continue',
					'resume',
					'fromPr',
					'appendSystemPrompt',
					'systemPrompt',
					'tools',
					'name',
					'mcpConfig',
					'strictMcpConfig',
					'allowedTools',
					'disallowedTools',
					'fallbackModel',
					'maxOutputTokens',
					'account',
				] as const
			).filter((key) => command.opts()[key] !== undefined)
			if (launchOnly.length > 0 && !['namzu', 'resume'].includes(action.name())) {
				const flags = launchOnly.map(
					(key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
				)
				// `drain` takes the model and mode flags after it, not the per-run ones.
				const perRun = launchOnly.some((key) => PER_RUN_FLAG_KEYS.has(key))
				command.error(
					action.name() === 'exec' || (action.name() === 'drain' && !perRun)
						? `${flags.join(', ')} before the command apply to the interactive TUI; for ${action.name()}, pass them after it: namzu ${action.name()} ${flags[0]} <value> "<prompt>".`
						: `${flags.join(', ')} apply to the interactive TUI, not this subcommand.`,
					{ exitCode: EX_USAGE, code: 'commander.invalidArgument' },
				)
			}
			if (
				action.name() === 'resume' &&
				(command.opts().continue !== undefined ||
					command.opts().resume !== undefined ||
					command.opts().fromPr !== undefined)
			)
				command.error(
					'--continue, --resume and --from-pr choose a conversation to open; `namzu resume <conversation-id>` already names one.',
					{ exitCode: EX_USAGE, code: 'commander.invalidArgument' },
				)
			if (action.name() === 'resume' && command.opts().message !== undefined)
				command.error(
					'The first message starts a new conversation; it is not sent when resuming one.',
					{ exitCode: EX_USAGE, code: 'commander.invalidArgument' },
				)
			// With -p the arguments were handed to `namzu exec` before parsing, so
			// a print-only option that reaches here was given without it.
			const needsPrint = (
				[
					['outputFormat', '--output-format'],
					['inputFormat', '--input-format'],
					['maxBudgetUsd', '--max-budget-usd'],
				] as const
			).filter(([key]) => command.opts()[key] !== undefined)
			if (needsPrint.length > 0) {
				const names = needsPrint.map(([, flag]) => flag)
				command.error(
					`${names.join(', ')} ${names.length === 1 ? 'needs' : 'need'} -p: namzu -p ${names[0]} <value> "<prompt>". For a subcommand, write it after the command.`,
					{ exitCode: EX_USAGE, code: 'commander.invalidArgument' },
				)
			}
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
			if (opensSessions(action.name()) && !asksForHelp(helpArgv)) {
				beginCatalogueRefresh(getBootstrapContext().config)
			}
		})
		.enablePositionalOptions(true)
		.exitOverride()
		.showHelpAfterError(false)
		.configureOutput({
			// Commander's one-line complaint becomes sentences, wrapped, with a way forward.
			outputError: (text, write) => write(formatUsageError(text, process.stderr.columns)),
		})

	addLaunchOptions(program)

	const buildContext = (
		load: () => ReturnType<typeof loadConfigWithProvenance>,
	): ResolvedCommandContext => {
		const globalOpts = program.opts<{
			format?: string
			quiet?: boolean
			verbose?: boolean
			logFormat?: string
			profile?: string
			pluginDir?: string[]
			bare?: boolean
		}>()
		const { config: loadedConfig, provenance } = load()
		// `--plugin-dir` is a launch decision, so it joins the plugin settings here
		// and never reaches a file. Folders are taken relative to where Namzu was
		// started.
		const launchDirs = [...new Set((globalOpts.pluginDir ?? []).map((dir) => resolve(dir)))]
		const fileConfig =
			launchDirs.length > 0
				? { ...loadedConfig, plugins: { ...loadedConfig.plugins, launchDirs } }
				: loadedConfig
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
		const configDebug = runtime().createConfigDebugSnapshot(provenance, {
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
			level: runtime().resolveLogLevel({
				verbose: globalOpts.verbose,
				quiet: globalOpts.quiet,
			}),
			format: runtime().resolveLogFormat({ logFormat: globalOpts.logFormat }),
		}
		return {
			formatter: createFormatter(format, { quiet }),
			config: { ...fileConfig, format, quiet },
			configDebug,
			logging,
			...(globalOpts.bare === true ? { bare: true } : {}),
		}
	}

	/** The settings layers `--bare` and `--settings` add; read once the command line is parsed. */
	let launchLayers: readonly LaunchSettingsLayer[] = []
	const selectedConfigOpts = (
		cwd?: string,
	): {
		readonly profile?: string
		readonly cwd?: string
		readonly launchLayers?: readonly LaunchSettingsLayer[]
	} => {
		const profile = program.opts<{ profile?: string }>().profile
		return {
			...(profile !== undefined ? { profile } : {}),
			...(cwd !== undefined ? { cwd } : {}),
			...(launchLayers.length > 0 ? { launchLayers } : {}),
		}
	}
	let bootstrapCtx: ResolvedCommandContext | null = null
	const trustedContexts = new Map<string, ResolvedCommandContext>()
	const getTrustedContext = (cwd: string): ResolvedCommandContext => {
		const target = resolve(cwd)
		const cached = trustedContexts.get(target)
		if (cached) return cached
		const loaded = runtime().loadConfigWithProvenance(selectedConfigOpts(target))
		const trusted = buildContext(() => loaded)
		runtime().emitBootNarrative(loaded.provenance, loaded.config)
		beginOtlpExport(loaded.config)
		trustedContexts.set(target, trusted)
		return trusted
	}
	/**
	 * Reads the user and project files again, for a host that starts a conversation after the
	 * process has been running. A file that no longer loads (half-written, or invalid) leaves the
	 * last good context in place; the Settings page reads the same files and says why.
	 */
	const refreshTrustedContext = (cwd: string): ResolvedCommandContext => {
		const target = resolve(cwd)
		return refreshCachedContext(
			trustedContexts,
			target,
			() => getTrustedContext(cwd),
			() => buildContext(() => runtime().loadConfigWithProvenance(selectedConfigOpts(target))),
			(error) =>
				runtime()
					.cliLogger()
					.warn('Settings could not be read again; this project keeps its last good settings', {
						'namzu.project.cwd': target,
						'exception.message': error instanceof Error ? error.message : String(error),
					}),
		)
	}
	const getBootstrapContext = (): ResolvedCommandContext => {
		if (bootstrapCtx) return bootstrapCtx
		const loaded = runtime().loadBootstrapConfigWithProvenance(selectedConfigOpts())
		const bootstrap = buildContext(() => loaded)
		// Before any project is trusted, so a project file cannot decide where a
		// sign-in is read from.
		runtime().configureDesktopSignInSharing(bootstrap.config.shareDesktopSignIn)
		// Claim stderr before any handler can log. A later TUI launch replaces
		// this with its ring sink; trusted project activation deliberately does
		// not replace that owner.
		runtime().installCliLogging(
			runtime().createStderrSink(bootstrap.logging.format),
			bootstrap.logging.level,
		)
		bootstrapCtx = bindTrustedProjectContext(bootstrap, getTrustedContext, refreshTrustedContext)
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
			profile?: string
		}>()
		const format: FormatName = (() => {
			if (globalOpts.format === undefined) return 'text'
			if (isFormatName(globalOpts.format)) return globalOpts.format
			throw new Error(`Commander admitted an invalid --format value: ${globalOpts.format}`)
		})()
		const quiet = globalOpts.quiet ?? false
		const logging: ResolvedLogging = {
			level: runtime().resolveLogLevel({
				verbose: globalOpts.verbose,
				quiet: globalOpts.quiet,
			}),
			format: runtime().resolveLogFormat({ logFormat: globalOpts.logFormat }),
		}
		// A recovery inventory has to work when ~/.namzu/config.yaml is the
		// damaged object being inspected. It therefore derives presentation only
		// from already-parsed global flags and never enters either config cascade.
		runtime().installCliLogging(runtime().createStderrSink(logging.format), logging.level)
		recoveryCtx = {
			formatter: createFormatter(format, { quiet }),
			config: { format, quiet },
			logging,
			...(globalOpts.profile ? { selectedProfile: globalOpts.profile } : {}),
		}
		return recoveryCtx
	}

	// Learning must stay reachable with broken config. Its turn action resolves
	// this bridge only after trusting the bound cwd.
	const getLearningContext = () =>
		bindTrustedProjectContext(getRecoveryContext(), getTrustedContext)
	const worktreeCommand = createLazyWorktreeCommand(async (target) => {
		const previous = process.cwd()
		try {
			process.chdir(target.worktree.path)
			await launchInteractiveTui(target.conversationId)
		} finally {
			process.chdir(previous)
		}
	})
	const palCommand = createLazyPalCommand(opts.resumeCommand)
	for (const def of [
		acpCommand,
		palCommand,
		computerCommand,
		archiveCommand,
		costCommand,
		peersCommand,
		sendCommand,
		watchCommand,
		doctorCommand,
		execCommand,
		learnCommand,
		learningCommand,
		loginCommand,
		logoutCommand,
		mcpCommand,
		drainCommand,
		evalCommand,
		historyCommand,
		hooksCommand,
		configCommand,
		extensionCommand,
		pluginCommand,
		skillsCommand,
		workspacesCommand,
		providersCommand,
		upgradeCommand,
		serveCommand,
		stateCommand,
		scheduleCommand,
		browserCommand,
		worktreeCommand,
		githubCommand,
	]) {
		registerCommandOrLazy(program, def, {
			getContext:
				def === learnCommand || def === learningCommand
					? getLearningContext
					: def === stateCommand ||
							def === worktreeCommand ||
							def === mcpCommand ||
							def === archiveCommand ||
							def === costCommand
						? getRecoveryContext
						: def === palCommand ||
								def === computerCommand ||
								def === acpCommand ||
								def === execCommand ||
								def === drainCommand ||
								def === skillsCommand ||
								def === hooksCommand ||
								def === configCommand ||
								def === extensionCommand ||
								def === pluginCommand ||
								def === upgradeCommand ||
								def === scheduleCommand ||
								def === browserCommand ||
								def === githubCommand
							? getBootstrapContext
							: getContext,
			setExitCode,
		})
	}

	/** The text of `namzu "<text>"`: the first message of the interactive launch. */
	let launchPrompt: string | undefined
	const launchInteractiveTui = async (
		initialConversationId?: string,
		/** `namzu resume` with no id: open the picker of this folder's conversations. */
		pickConversation = false,
	): Promise<void> => {
		if (process.stdout.isTTY) {
			const launchOpts = program.opts<{
				dangerouslySkipPermissions?: boolean
				allowDangerouslySkipPermissions?: boolean
				outputSchema?: string
				addDir?: string[]
				provider?: string
				account?: string
				model?: string
				maxOutputTokens?: number
				doneGate?: boolean
				effort?: (typeof REASONING_EFFORT_LEVELS)[number]
				fast?: boolean
				permissionMode?: (typeof PERMISSION_MODE_NAMES)[number]
				message?: string
				appendSystemPrompt?: string
				systemPrompt?: string
				tools?: string
				name?: string
				bare?: boolean
				mcpConfig?: string[]
				strictMcpConfig?: boolean
				allowedTools?: string[]
				disallowedTools?: string[]
				fallbackModel?: string[]
				maxBudgetUsd?: string
				continue?: boolean
				resume?: string | true
				fromPr?: string | true
			}>()
			// `-c` / `-r`: pick the conversation before anything else is built, so a
			// refusal costs no provider discovery and never falls back to a new one.
			let conversationId = initialConversationId
			let openResumePicker:
				| { readonly query?: string; readonly pr?: PullRequestFilter }
				| undefined = pickConversation ? {} : undefined
			if (
				conversationId === undefined &&
				(launchOpts.continue || launchOpts.resume !== undefined || launchOpts.fromPr !== undefined)
			) {
				const { resolveTuiResume } = await import('./commands/resume.js')
				const { openSessions, closeSessions } = await import('./integrations/sessions/store.js')
				let sessions: Awaited<ReturnType<typeof openSessions>> | null = null
				try {
					sessions = await openSessions(process.cwd())
				} catch {
					sessions = null
				}
				let outcome: Awaited<ReturnType<typeof resolveTuiResume>>
				try {
					outcome = await resolveTuiResume(
						sessions,
						{
							continueLast: launchOpts.continue === true,
							resume: launchOpts.resume ?? null,
							fromPr: launchOpts.fromPr ?? null,
						},
						process.cwd(),
					)
				} finally {
					if (sessions) closeSessions(sessions)
				}
				if (outcome.kind === 'error') {
					getBootstrapContext().formatter.error({ message: outcome.message })
					setExitCode(EX_USAGE)
					return
				}
				if (outcome.kind === 'open') conversationId = outcome.sessionId
				if (outcome.kind === 'picker')
					openResumePicker = {
						...(outcome.query === undefined ? {} : { query: outcome.query }),
						...(outcome.pr === undefined ? {} : { pr: outcome.pr }),
					}
			}
			const structuredOutput = launchOpts.outputSchema
				? (await import('./output-schema.js')).loadOutputSchema(
						resolve(process.cwd(), launchOpts.outputSchema),
					)
				: undefined
			// A spend limit stops a headless run; nothing here would honour it, and a
			// limit that is accepted and ignored is worse than a refusal.
			if (launchOpts.maxBudgetUsd !== undefined) {
				getBootstrapContext().formatter.error({
					message:
						'--max-budget-usd stops a headless run at a dollar amount; pass it after the command: namzu exec --max-budget-usd <amount> "<prompt>".',
				})
				setExitCode(EX_USAGE)
				return
			}
			// The four per-run flags are read once, here, so a bad value is refused
			// before the screen opens rather than reported inside it.
			const runFlags = runtime().resolveRunFlags(
				{
					appendSystemPrompt: launchOpts.appendSystemPrompt ?? null,
					systemPrompt: launchOpts.systemPrompt ?? null,
					tools: launchOpts.tools ?? null,
					allowedTools: launchOpts.allowedTools ?? [],
					disallowedTools: launchOpts.disallowedTools ?? [],
					fallbackModels: launchOpts.fallbackModel ?? [],
				},
				{ version: 3, providers: [], subagents: { active: [] } },
			)
			if ('error' in runFlags) {
				getBootstrapContext().formatter.error({ message: runFlags.error })
				setExitCode(EX_USAGE)
				return
			}
			const skipPermissions = Boolean(launchOpts.dangerouslySkipPermissions)
			// What the command line and the configuration let this launch start in.
			// A mode that stops asking is refused here, in plain words, before
			// anything is built: a flag the settings or the root guard forbid is an
			// error, not a quiet downgrade. With nothing chosen, the interactive
			// terminal's own default is auto, settled once the session knows
			// whether its classifier can reach a model.
			const permissionPlanFor = (config: NamzuCliConfig) =>
				runtime().planLaunchMode({
					permissionModeFlag: launchOpts.permissionMode,
					skipPermissions,
					allowBypassFlag: launchOpts.allowDangerouslySkipPermissions === true,
					settings: config.permissionSettings,
					interactive: true,
				})
			const firstPlan = permissionPlanFor(getBootstrapContext().config)
			if ('error' in firstPlan) {
				getBootstrapContext().formatter.error({ message: firstPlan.error })
				setExitCode(EX_USAGE)
				return
			}
			let launchPlan = firstPlan.plan
			// Bypass runs everything, so the person is asked once, here, before the
			// screen opens. Declining starts the session in the ordinary mode.
			if (launchPlan.mode === 'bypass' && !runtime().hasAcknowledgedBypass()) {
				if (await runtime().askBypassConsent()) {
					try {
						runtime().acknowledgeBypass()
					} catch {
						// An unwritable home costs a repeat of the question next time.
					}
				} else {
					launchPlan = { ...launchPlan, mode: 'prompt', source: 'default' }
				}
			}
			let modelEnvironment: ReturnType<typeof readModelLaunchEnvironment>
			try {
				modelEnvironment = readModelLaunchEnvironment()
			} catch (error) {
				getBootstrapContext().formatter.error({ message: (error as Error).message })
				setExitCode(EXIT_BAD_CONFIG)
				return
			}
			const provider = (launchOpts.provider ?? modelEnvironment.provider)?.trim()
			let launchAccount: string | undefined
			if (launchOpts.account !== undefined) {
				const { openCliAccounts } = await import('./integrations/accounts/open.js')
				const { findAccountByName } = await import('./integrations/accounts/binding.js')
				let found: ReturnType<typeof findAccountByName>
				try {
					found = findAccountByName(openCliAccounts().registry, launchOpts.account)
				} catch (error) {
					getBootstrapContext().formatter.error({
						message: `Could not read your accounts: ${(error as Error).message}`,
					})
					setExitCode(EXIT_BAD_CONFIG)
					return
				}
				if ('error' in found) {
					getBootstrapContext().formatter.error({ message: found.error })
					setExitCode(EX_USAGE)
					return
				}
				if (provider && provider !== found.account.provider) {
					getBootstrapContext().formatter.error({
						message: `--account ${launchOpts.account} belongs to ${found.account.provider}, not ${provider}. Drop --provider or name another account.`,
					})
					setExitCode(EX_USAGE)
					return
				}
				launchAccount = found.account.id
			}
			const model = (launchOpts.model ?? modelEnvironment.model)?.trim()
			const effort = launchOpts.effort ?? modelEnvironment.effort
			// Saved defaults sit below the flag and the variable: the person's `fast` and `effort`
			// settings start a conversation the way `--fast` and `--effort` would.
			const savedConfig = getBootstrapContext().config
			const launchSettings = {
				...(provider ? { provider } : {}),
				...(launchAccount ? { account: launchAccount } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				...(launchOpts.fast === true ? { fast: true } : {}),
				...(launchOpts.fast !== true && savedConfig.fast === true ? { savedFast: true } : {}),
				...(!effort && savedConfig.effort ? { savedEffort: savedConfig.effort } : {}),
				...(launchPlan.source === 'launch-flag' || launchPlan.source === 'config-default'
					? { permissionMode: launchPlan.mode }
					: {}),
				...(launchPrompt?.trim() ? { message: launchPrompt } : {}),
				...(launchOpts.name?.trim() ? { name: launchOpts.name.trim() } : {}),
				...(launchOpts.fallbackModel?.length ? { fallbackModels: launchOpts.fallbackModel } : {}),
			}
			// The same three lines `exec` uses. The TUI compiled
			// nothing at all, so a `permissions` table in a config file did nothing
			// in the mode most people actually use.
			const commandCtx = getBootstrapContext()
			beginCatalogueRefresh(commandCtx.config)
			// The tool server files are read before the screen opens, so a missing or
			// broken one is refused here and not reported inside it.
			const mcpCheck = runtime().launchMcpServers(
				commandCtx.config.mcpServers,
				launchOpts.mcpConfig ?? [],
				launchOpts.strictMcpConfig === true,
			)
			if ('error' in mcpCheck) {
				commandCtx.formatter.error({ message: mcpCheck.error })
				setExitCode(EX_USAGE)
				return
			}
			const buildTuiContext = (resolvedCtx: ResolvedCommandContext, cwd: string) => {
				const launchMcp = runtime().launchMcpServers(
					resolvedCtx.config.mcpServers,
					launchOpts.mcpConfig ?? [],
					launchOpts.strictMcpConfig === true,
				)
				if ('error' in launchMcp) throw new Error(launchMcp.error)
				runtime().warnLegacyMcpPermissionNames(resolvedCtx.config.permissions)
				runtime().warnBroadAllowRules(cwd, runtime().cliLogger())
				const permissions = runtime().compilePermissionLayers(
					[...runtime().permissionLayersOf(resolvedCtx.config), ...runFlags.permissionLayers],
					resolvedCtx.config.permissionChecks,
				)
				for (const d of permissions.diagnostics) {
					const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
					resolvedCtx.formatter.error({ message: `${where}: ${d.message}` })
				}
				// The browser is the TUI's alone. Its site rules go ahead of the
				// table, behind any table deny that names a browser tool.
				const browserConfig = resolvedCtx.config.browser
				const browserSites =
					browserConfig?.enabled === false
						? undefined
						: runtime().compileBrowserSites(browserConfig?.sites)
				for (const message of browserSites?.diagnostics ?? []) {
					resolvedCtx.formatter.error({ message })
				}
				const livePermissionRules = runtime().createLivePermissionRules({
					cwd,
					layers: [
						...runtime().permissionLayersOf(resolvedCtx.config),
						...runFlags.permissionLayers,
					],
					...(browserSites ? { browserRules: browserSites.rules } : {}),
				})
				const additionalDirectories = [
					...(resolvedCtx.config.additionalDirectories ?? []),
					...(launchOpts.addDir ?? []),
				].map((dir) => resolve(cwd, dir))
				const fullPlanResult = permissionPlanFor(resolvedCtx.config)
				const fullPlan = 'plan' in fullPlanResult ? fullPlanResult.plan : undefined
				return {
					cwd,
					...(structuredOutput ? { structuredOutput } : {}),
					version: CLI_VERSION,
					configDebug: resolvedCtx.configDebug,
					skipPermissions: skipPermissions && launchPlan.source === 'launch-bypass',
					...(launchOpts.allowDangerouslySkipPermissions
						? { allowDangerouslySkipPermissions: true }
						: {}),
					// Auto as the default holds only while the full configuration, the
					// project's file included, still leaves the choice to it: a project
					// may name a default of its own or switch auto off.
					permissionSource:
						launchPlan.source === 'auto-default' && fullPlan?.source !== 'auto-default'
							? 'default'
							: launchPlan.source,
					...(runFlags.appendSystem ? { appendSystem: runFlags.appendSystem } : {}),
					...(runFlags.replaceSystem ? { replaceSystem: runFlags.replaceSystem } : {}),
					...(runFlags.onlyTools ? { onlyTools: runFlags.onlyTools } : {}),
					...(launchOpts.bare === true ? { bare: true } : {}),
					// The project's own file may close bypass or auto for its folder, so the
					// door is recomputed from the full configuration.
					bypassAvailable: fullPlan?.bypassAvailable === true,
					...(resolvedCtx.config.permissionSettings
						? { permissionSettings: resolvedCtx.config.permissionSettings }
						: {}),
					...(Object.keys(launchSettings).length > 0 ? { launchSettings } : {}),
					...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
					rules: livePermissionRules.rules,
					reloadPermissionRules: livePermissionRules.reload,
					...(browserSites ? { browser: { ...browserConfig, sites: browserSites.sites } } : {}),
					logging: resolvedCtx.logging,
					...(conversationId ? { initialConversationId: conversationId } : {}),
					...(openResumePicker ? { openResumePicker } : {}),
					...(launchMcp.servers ? { mcpServers: launchMcp.servers } : {}),
					...(resolvedCtx.config.plugins ? { plugins: resolvedCtx.config.plugins } : {}),
					...(resolvedCtx.config.skills ? { skills: resolvedCtx.config.skills } : {}),
					...(resolvedCtx.config.composerTriggers
						? { composerTriggers: resolvedCtx.config.composerTriggers }
						: {}),
					...(resolvedCtx.config.hypermode === true ? { hypermode: true } : {}),
					...(resolvedCtx.config.refusalFallback
						? { refusalFallback: resolvedCtx.config.refusalFallback }
						: {}),
					...(resolvedCtx.config.learningObservations === false
						? { learningObservations: false }
						: {}),
					...(resolvedCtx.config.learningGenerator !== undefined
						? { learningGenerator: resolvedCtx.config.learningGenerator }
						: {}),
					...(resolvedCtx.config.telemetry ? { telemetry: resolvedCtx.config.telemetry } : {}),
					...(resolvedCtx.config.web ? { web: resolvedCtx.config.web } : {}),
					...(resolvedCtx.config.smallModel ? { smallModel: resolvedCtx.config.smallModel } : {}),
					...(resolvedCtx.config.hooks ? { hooks: resolvedCtx.config.hooks } : {}),
					...(hookSwitch(resolvedCtx.config)
						? { hooksSwitch: hookSwitch(resolvedCtx.config) }
						: {}),
					...(resolvedCtx.config.statusLine ? { statusLine: resolvedCtx.config.statusLine } : {}),
					...(resolvedCtx.config.compaction ? { compaction: resolvedCtx.config.compaction } : {}),
					...(resolvedCtx.config.memory ? { memory: resolvedCtx.config.memory } : {}),
					...(resolvedCtx.config.limits ||
					launchOpts.maxOutputTokens !== undefined ||
					launchOpts.doneGate === false
						? {
								limits: {
									...resolvedCtx.config.limits,
									...(launchOpts.maxOutputTokens !== undefined
										? { maxResponseTokens: launchOpts.maxOutputTokens }
										: {}),
									...(launchOpts.doneGate === false ? { doneGate: false } : {}),
								},
							}
						: {}),
					...(resolvedCtx.config.workflow ? { workflow: resolvedCtx.config.workflow } : {}),
					...(resolvedCtx.config.goal ? { goal: resolvedCtx.config.goal } : {}),
					...(resolvedCtx.config.handBack ? { handBack: resolvedCtx.config.handBack } : {}),
					...(resolvedCtx.config.effort ? { savedEffort: resolvedCtx.config.effort } : {}),
					...(resolvedCtx.config.closingSummary === false ? { closingSummary: false } : {}),
					...(resolvedCtx.config.agentSettings === false ? { agentSettings: false } : {}),
					...(resolvedCtx.config.outputStyle
						? { outputStyle: resolvedCtx.config.outputStyle }
						: {}),
					...(resolvedCtx.config.attribution
						? { attribution: resolvedCtx.config.attribution }
						: {}),
					...(resolvedCtx.config.promptSuggestions === false ? { promptSuggestions: false } : {}),
					...(resolvedCtx.config.respectGitignore === false ? { respectGitignore: false } : {}),
					...(resolvedCtx.config.sandbox ? { sandbox: resolvedCtx.config.sandbox } : {}),
					...(resolvedCtx.config.decision ? { decision: resolvedCtx.config.decision } : {}),
					...(resolvedCtx.config.codeAnalysis
						? { codeAnalysis: resolvedCtx.config.codeAnalysis }
						: {}),
					...(resolvedCtx.config.computerUse
						? { computerUse: resolvedCtx.config.computerUse }
						: {}),
					// Read again from the files each turn: the setting is changed in `/config` or
					// Settings while a conversation is open, and applies from the next message.
					readComputerUseEnabled: () =>
						refreshTrustedProjectContext(commandCtx, cwd).config.computerUse?.enabled === true,
					...(resolvedCtx.config.progressNudge
						? { progressNudge: resolvedCtx.config.progressNudge }
						: {}),
					// A configured `routing` block makes Auto an available choice;
					// `model: auto` makes it the default, and only when nothing pins a
					// model for this launch: an explicit `--model` always wins.
					...(resolvedCtx.config.routing
						? {
								routing: resolvedCtx.config.routing,
								autoDefault: resolvedCtx.config.model === 'auto' && !model,
							}
						: {}),
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
					...(resolvedCtx.config.network ? { network: resolvedCtx.config.network } : {}),
					runNetwork: true,
					...(resolvedCtx.config.updates ? { updates: resolvedCtx.config.updates } : {}),
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
	addLaunchOptions(
		program
			.command('resume')
			.description('Resume an interactive conversation; without an id, choose from a list')
			.argument(
				'[conversation-id]',
				'Conversation id printed when the TUI exited; leave out to pick one',
			),
	).action(async (conversationId: string | undefined) => {
		if (conversationId === undefined) {
			await launchInteractiveTui(undefined, true)
			return
		}
		// Conversations are stored per folder. A scheduled run's id resumed
		// from elsewhere would only be "not found"; say where it lives.
		const { scheduledSessionElsewhere } = await import('./schedule/resume-command.js')
		const elsewhere = scheduledSessionElsewhere(
			runtime().resolveNamzuHome(),
			conversationId,
			process.cwd(),
		)
		if (elsewhere) {
			process.stderr.write(
				`namzu: ${conversationId} is a run of the scheduled job ${elsewhere.job.name}, and its conversation is stored with the job’s folder, ${elsewhere.job.folder.canonical}. Open it there:\n  ${elsewhere.command}\n`,
			)
			setExitCode(EX_USAGE)
			return
		}
		await launchInteractiveTui(conversationId)
	})

	// Listed so `namzu --help` says it exists. `runCli` turns `namzu help ...` into
	// `namzu ... --help` before commander parses, so this never runs an action.
	program
		.command('help')
		.description('Show help for a command: namzu help <command> [action...]')
		.argument('[command]')
		.argument('[action...]')

	// Default behavior when `namzu` is invoked with no subcommand: launch
	// the TUI (M3). When stdout is not a TTY (tests, pipes, CI), print a
	// one-line marker instead so the binary stays scriptable and our test
	// suite does not try to render Ink against a non-tty stream.
	program.action(async (prompt: string | undefined) => {
		const hidden = program.opts<{ message?: string }>().message
		if (prompt !== undefined && hidden !== undefined)
			program.error('Give the first message once: namzu "<text>".', {
				exitCode: EX_USAGE,
				code: 'commander.invalidArgument',
			})
		launchPrompt = prompt ?? hidden ?? promptAfterDashes
		await launchInteractiveTui()
	})

	// `namzu -- "<text>"`: the text after `--` is the first message even when
	// it begins with a dash or spells a command, so it never reaches the
	// command lookup.
	let argv = opts.argv as string[]
	let promptAfterDashes: string | undefined
	const dashed = dashedPrompt(program, argv.slice(2))
	if (dashed !== undefined) {
		argv = argv.slice(0, 2 + dashed.index)
		promptAfterDashes = dashed.prompt
	}
	// `namzu -p "<prompt>"` is `namzu exec "<prompt>"`.
	const printed = printModeArgs(program, argv.slice(2))
	if (printed !== undefined) argv = [...argv.slice(0, 2), ...printed]
	else {
		const hoisted = hoistExecLaunchFlags(program, argv.slice(2))
		if (hoisted !== undefined) argv = [...argv.slice(0, 2), ...hoisted]
	}

	try {
		// `namzu help [command] [action...]` prints what `namzu <command> [action...]
		// --help` prints. Rewritten before commander parses, so the command's own
		// help path answers and the two cannot differ. A name that is not a command
		// loses the word `help`: a retired name prints its line, any other is an
		// unknown command (checked below).
		const helpOf = helpTarget(program, argv)
		argv = [...rewriteHelpCommand(program, argv)]
		helpArgv = argv
		// Help never reads or writes the Namzu home, so a `NAMZU_HOME` that names a
		// folder which does not exist (yet) must not stop it: the home is checked
		// when a context is built, and a context is built before a command prints
		// its help. Set aside for this call and put back in the `finally`.
		if (asksForHelp(argv) && process.env.NAMZU_HOME !== undefined) {
			setAsideHome = { value: process.env.NAMZU_HOME }
			// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the text "undefined"
			delete process.env.NAMZU_HOME
		}
		// Checked before commander parses, because commander answers `--help`
		// before it looks at the operands: `namzu run --help` would otherwise
		// print the root help and exit 0 without naming what replaced `run`.
		const hint = removedSpellingHint(program, argv.slice(2))
		if (hint !== undefined) {
			// One line, naming the replacement: the old spelling is not a command any more.
			program.error(hint, {
				exitCode: EX_USAGE,
				code: 'commander.unknownCommand',
			})
		}
		// `namzu help <word>` where the word names no command is an unknown command,
		// not a first message: the root takes a prompt, so the check is made here.
		if (helpOf !== undefined && !isCommandName(program, helpOf)) {
			program.error(`unknown command '${helpOf}'`, {
				exitCode: EX_USAGE,
				code: 'commander.unknownCommand',
			})
		}
		await program.parseAsync(argv, { from: 'node' })
		return exitCode
	} catch (err) {
		if (err instanceof CommanderError) {
			return mapCommanderError(err)
		}
		// A config file the operator can fix. The message names the file and
		// what is wrong with it; a stack trace would only point at the reader
		// that noticed, which is not where the problem is.
		if (rt !== undefined && err instanceof rt.ConfigLoadError) {
			const next = err.complete
				? ''
				: 'namzu will not start with a config it cannot read. Fix the file or remove it.\n'
			// The parser's own wording is for whoever asked for detail.
			const detail =
				err.complete && err.cause instanceof Error && debugRequested(process.env, opts.argv)
					? `${err.cause.message}\n`
					: ''
			process.stderr.write(`${err.message}\n${next}${detail}`)
			return EXIT_BAD_CONFIG
		}
		if (rt !== undefined && err instanceof rt.ConfigValueError) {
			const remediation =
				err.source.kind === 'file'
					? 'Fix the named setting or remove it from that file.'
					: `Fix or unset ${err.source.variable}.`
			process.stderr.write(
				`${err.message}\nnamzu will not start with an explicit config value it cannot honour. ${remediation}\n`,
			)
			return EXIT_BAD_CONFIG
		}
		// Only now, on the failure path: the report names a log under the Namzu
		// home, which is the SDK's to resolve.
		const { reportCrash } = await import('./crash-report.js')
		process.stderr.write(reportCrash(err))
		return EXIT_INTERNAL_ERROR
	} finally {
		if (setAsideHome !== undefined) process.env.NAMZU_HOME = setAsideHome.value
		catalogueRefresh?.cancel()
		await (await otlpExport)?.shutdown()
	}
}

/** The root options that `-p` leaves on the root: the output controls, not the run's options. */
const PRINT_ROOT_FLAGS = new Set(['-q', '--quiet', '-v', '--verbose', '--debug', '--bare'])
const PRINT_ROOT_VALUE_FLAGS = new Set([
	'-f',
	'--format',
	'--log-format',
	'--settings',
	'--debug-file',
])

/**
 * The arguments of `namzu -p …`, as `namzu exec …`: the root's output
 * controls stay in front, every other word goes after `exec`, which reads
 * them as it always has. Undefined when the call is not print mode: no `-p`,
 * or a subcommand name came first, so the `-p` belongs to that command.
 */
export function printModeArgs(program: Command, args: readonly string[]): string[] | undefined {
	const end = args.indexOf('--')
	const head = end === -1 ? args : args.slice(0, end)
	if (!head.some((arg) => arg === '-p' || arg === '--print')) return undefined
	const first = firstRootOperand(program, head)
	if (first !== undefined && isCommandName(program, first)) return undefined
	if (first !== undefined && Object.hasOwn(REMOVED_COMMANDS, first)) return undefined
	const root: string[] = []
	const rest: string[] = []
	for (let i = 0; i < head.length; i++) {
		const arg = head[i] as string
		if (PRINT_ROOT_FLAGS.has(arg)) root.push(arg)
		else if (PRINT_ROOT_VALUE_FLAGS.has(arg)) {
			root.push(arg)
			if (i + 1 < head.length) root.push(head[++i] as string)
		} else if (
			arg.startsWith('--format=') ||
			arg.startsWith('--log-format=') ||
			arg.startsWith('--settings=') ||
			arg.startsWith('--debug-file=')
		)
			root.push(arg)
		else rest.push(arg)
	}
	return [...root, 'exec', ...rest, ...args.slice(head.length)]
}

/**
 * `namzu exec … --bare --settings <x> --debug-file <p>`: these three shape the
 * process (which settings load, where logs go), not the run, so they are read
 * by the root. Written after `exec`, they are moved in front of it. Undefined
 * when the call is not `exec` or none of them follows it.
 */
export function hoistExecLaunchFlags(
	program: Command,
	args: readonly string[],
): string[] | undefined {
	let at = -1
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--') return undefined
		if (args[i] === 'exec' && firstRootOperand(program, args.slice(0, i + 1)) === 'exec') {
			at = i
			break
		}
	}
	if (at === -1) return undefined
	const end = args.indexOf('--', at)
	const tail = end === -1 ? args.slice(at + 1) : args.slice(at + 1, end)
	const moved: string[] = []
	const kept: string[] = []
	for (let i = 0; i < tail.length; i++) {
		const arg = tail[i] as string
		if (arg === '--bare') moved.push(arg)
		else if (arg === '--settings' || arg === '--debug-file') {
			moved.push(arg)
			if (i + 1 < tail.length) moved.push(tail[++i] as string)
		} else if (arg.startsWith('--settings=') || arg.startsWith('--debug-file=')) moved.push(arg)
		else kept.push(arg)
	}
	if (moved.length === 0) return undefined
	return [...args.slice(0, at), ...moved, 'exec', ...kept, ...(end === -1 ? [] : args.slice(end))]
}

function isCommandName(program: Command, name: string): boolean {
	return program.commands.some(
		(command) => command.name() === name || command.aliases().includes(name),
	)
}

/**
 * `namzu [root options] -- "<text>"`: where the `--` is and the one word
 * after it. Undefined when there is no `--` at the root, or an operand
 * came first (the `--` then belongs to that command).
 */
function dashedPrompt(
	program: Command,
	args: readonly string[],
): { index: number; prompt: string } | undefined {
	const index = args.indexOf('--')
	if (index === -1) return undefined
	const before = args.slice(0, index)
	if (firstRootOperand(program, before) !== undefined) return undefined
	if (before.some((arg) => arg === '-p' || arg === '--print')) return undefined
	if (args.length !== index + 2) return undefined
	return { index, prompt: args[index + 1] as string }
}

/**
 * Where the first operand the root command would see sits in `args`, read the
 * way commander reads it: root options and their values are skipped, `-h` and
 * `--help` are flags, and an unknown option or `--` ends the search, because
 * after either commander stops treating what follows as a command name.
 */
function firstRootOperandIndex(program: Command, args: readonly string[]): number | undefined {
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
		return i
	}
	return undefined
}

/**
 * The one line to print when `args` use a retired spelling, or undefined. The
 * flag is looked for before `--`, on every command; a command and
 * its action are matched as typed, side by side.
 */
function removedSpellingHint(program: Command, args: readonly string[]): string | undefined {
	const end = args.indexOf('--')
	const head = end === -1 ? args : args.slice(0, end)
	const sawYolo = head.some((a) => a === '--yolo' || a.startsWith('--yolo='))
	const visible = sawYolo ? head.filter((a) => a !== '--yolo' && !a.startsWith('--yolo=')) : head
	const at = firstRootOperandIndex(program, visible)
	const name = at === undefined ? undefined : visible[at]
	if (name !== undefined) {
		const byName = REMOVED_COMMANDS[name]
		if (byName !== undefined) return byName
		const action = visible[(at as number) + 1]
		const byAction = action === undefined ? undefined : REMOVED_COMMANDS[`${name} ${action}`]
		if (byAction !== undefined) return byAction
	}
	if (sawYolo) return REMOVED_COMMANDS['--yolo']
	return undefined
}

/**
 * `namzu help [command] [action...]` becomes `namzu [command] [action...]
 * --help`; a first word that names no command is kept without `--help`, so
 * the error is the one that word would get on its own.
 */
function rewriteHelpCommand(program: Command, argv: readonly string[]): readonly string[] {
	const args = argv.slice(2)
	const at = firstRootOperandIndex(program, args)
	if (at === undefined || args[at] !== 'help') return argv
	const before = args.slice(0, at)
	const rest = args.slice(at + 1).filter((a) => a !== '--help' && a !== '-h')
	const target = rest[0]
	const known = target !== undefined && program.commands.some((c) => c.name() === target)
	const tail = target === undefined || known ? [...rest, '--help'] : rest
	return [...argv.slice(0, 2), ...before, ...tail]
}

/** The word after `namzu help`, or undefined when the call is not `namzu help <word>`. */
function helpTarget(program: Command, argv: readonly string[]): string | undefined {
	const args = argv.slice(2)
	const at = firstRootOperandIndex(program, args)
	if (at === undefined || args[at] !== 'help') return undefined
	return args.slice(at + 1).find((a) => a !== '--help' && a !== '-h')
}

/** The first operand the root command would see in `args`, or undefined. */
function firstRootOperand(program: Command, args: readonly string[]): string | undefined {
	const at = firstRootOperandIndex(program, args)
	return at === undefined ? undefined : args[at]
}

/** Whether the command line asks for help, which never needs the Namzu home. */
function asksForHelp(argv: readonly string[]): boolean {
	const args = argv.slice(2)
	const end = args.indexOf('--')
	const head = end === -1 ? args : args.slice(0, end)
	return head.includes('--help') || head.includes('-h')
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
