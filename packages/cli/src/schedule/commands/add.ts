/**
 * `schedule add`, `schedule edit` and `schedule confirm`.
 *
 * A job is confirmed only by a person: on a terminal here, or in the TUI's
 * `/schedule` panel. Without a terminal (`--yes`, a script, a model's own
 * bash call) the job is written INERT — `pending-confirmation` — and the
 * daemon will not run it until someone confirms it. `--yes` means "do not
 * ask", never "consider it confirmed".
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandContext } from '../../commands/types.js'
import { readPermissionLayers } from '../../config/load.js'
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import type { PermissionsConfig } from '../../permissions/rules.js'
import {
	type JobRequest,
	JobRequestError,
	buildJob,
	confirmJob,
	editedJob,
	previewLines,
} from '../build.js'
import {
	changesBlock,
	changesSinceConfirmed,
	confirmationView,
	describeChanges,
} from '../changes.js'
import { isPrivacyProtectedFolder } from '../folder.js'
import type { SchedulePaths } from '../paths.js'
import { type PermissionInput, compileJobPolicy, isPresetName } from '../policy.js'
import { verifyScheduledScript } from '../script-check.js'
import { appendHistory, readHistory } from '../store/history.js'
import { createJob, findJob, updateJob } from '../store/jobs.js'
import type { ScheduleJob, ScheduleRunKind } from '../types.js'
import {
	type ParsedArgs,
	flag,
	has,
	interactive,
	parseArgs,
	parseCount,
	parseMs,
	pathsFor,
} from './args.js'
import { askYesNo } from './confirm-prompt.js'

export const ADD_FLAGS = [
	'home',
	'prompt',
	'prompt-file',
	'when',
	'folder',
	'permissions',
	'unmatched',
	'execution',
	'tz',
	'model',
	'effort',
	'max-iterations',
	'token-budget',
	'timeout',
	'wait-for-provider',
	'approval-ttl',
	'keep-sessions',
	'pause-after-failures',
	'add-dir',
	'paused!',
	'yes!',
	'allow-unattended-host!',
	'notify-summary!',
	'browser',
	'browser-site',
	'browser-headed!',
	'no-browser!',
	'kind',
	'script',
	'script-file',
	'shell',
	'script-timeout',
] as const

const RUN_KINDS: readonly ScheduleRunKind[] = ['agent', 'script', 'script+agent']

function isRunKind(value: string): value is ScheduleRunKind {
	return (RUN_KINDS as readonly string[]).includes(value)
}

/** `--script`/`--script-file`, mutually exclusive, mirroring `--prompt`/`--prompt-file`. */
function scriptBodyOf(args: ParsedArgs): string | undefined {
	const inline = flag(args, 'script')
	const file = flag(args, 'script-file')
	if (inline !== undefined && file !== undefined) {
		throw new JobRequestError('pass --script or --script-file, not both')
	}
	if (file !== undefined) return readFileSync(resolve(file), 'utf8')
	return inline
}

/**
 * `--browser <profile>`, `--browser-site <site>=read|ask|act` (repeatable)
 * and `--browser-headed`, over the grant a job already has (an edit). On an
 * edit a site is added or its level changed, `<site>=none` takes it off,
 * and `--no-browser` drops the grant. `undefined`: no grant.
 */
export function browserInput(
	args: ParsedArgs,
	base?: PermissionInput['browser'],
): PermissionInput['browser'] | undefined {
	const profile = flag(args, 'browser')
	const written = args.flags.get('browser-site') ?? []
	if (has(args, 'no-browser')) {
		if (profile !== undefined || written.length > 0 || has(args, 'browser-headed')) {
			throw new JobRequestError('--no-browser cannot be combined with other --browser flags')
		}
		return undefined
	}
	if (!base && profile === undefined) {
		if (written.length > 0 || has(args, 'browser-headed')) {
			throw new JobRequestError(
				'--browser-site and --browser-headed need --browser <profile>: the profile you signed in with `namzu browser login`',
			)
		}
		return undefined
	}
	const sites: Record<string, string> = { ...(base?.sites ?? {}) }
	for (const entry of written) {
		const at = entry.lastIndexOf('=')
		const site = at > 0 ? entry.slice(0, at).trim() : ''
		const level = at > 0 ? entry.slice(at + 1).trim() : ''
		if (!site || !level) {
			throw new JobRequestError(
				`--browser-site ${entry}: write <site>=read, <site>=ask or <site>=act, e.g. https://github.com=read`,
			)
		}
		if (level === 'none') {
			if (!base)
				throw new JobRequestError(
					`--browser-site ${entry}: none only takes a site off an existing job`,
				)
			const key = Object.keys(sites).find(
				(k) => k.toLowerCase() === site.toLowerCase().replace(/\/+$/, ''),
			)
			if (key === undefined)
				throw new JobRequestError(`--browser-site ${entry}: the job has no site ${site}`)
			delete sites[key]
			continue
		}
		sites[site] = level
	}
	return {
		profile: profile ?? (base?.profile as string),
		sites,
		...(has(args, 'browser-headed') || base?.headed ? { headed: true } : {}),
	}
}

function permissionInput(
	args: ParsedArgs,
	baseBrowser?: PermissionInput['browser'],
): PermissionInput {
	const value = flag(args, 'permissions')
	const browser = browserInput(args, baseBrowser)
	if (!value && browser) {
		const unmatched = flag(args, 'unmatched')
		if (unmatched !== 'park' && unmatched !== 'deny' && unmatched !== 'allow') {
			throw new JobRequestError(
				'a job with only a browser grant needs --unmatched park|deny|allow (or add --permissions read-only)',
			)
		}
		return {
			unmatched,
			browser,
			...(flag(args, 'execution') === 'sandbox' ? { execution: 'sandbox' as const } : {}),
		}
	}
	if (!value) {
		throw new JobRequestError(
			'--permissions is required: read-only, edit-in-folder, or a JSON file with {"rules": {...}, "unmatched": "park"|"deny"|"allow"}',
		)
	}
	let input: PermissionInput
	if (isPresetName(value)) input = { preset: value }
	else {
		let parsed: {
			preset?: unknown
			rules?: unknown
			unmatched?: unknown
			execution?: unknown
			additionalDirectories?: unknown
			browser?: unknown
		}
		try {
			parsed = JSON.parse(readFileSync(resolve(value), 'utf8'))
		} catch (error) {
			throw new JobRequestError(
				`--permissions ${value} is neither a preset (read-only, edit-in-folder) nor a readable JSON file: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		input = {
			...(isPresetName(parsed.preset) ? { preset: parsed.preset } : {}),
			...(parsed.rules && typeof parsed.rules === 'object'
				? { rules: parsed.rules as PermissionsConfig }
				: {}),
			...(parsed.unmatched === 'park' || parsed.unmatched === 'deny' || parsed.unmatched === 'allow'
				? { unmatched: parsed.unmatched }
				: {}),
			...(parsed.execution === 'host' || parsed.execution === 'sandbox'
				? { execution: parsed.execution }
				: {}),
			...(Array.isArray(parsed.additionalDirectories)
				? { additionalDirectories: parsed.additionalDirectories.map(String) }
				: {}),
			...(parsed.browser && typeof parsed.browser === 'object'
				? { browser: parsed.browser as NonNullable<PermissionInput['browser']> }
				: {}),
		}
	}
	if (browser) input = { ...input, browser }
	const unmatched = flag(args, 'unmatched')
	if (unmatched !== undefined) {
		if (unmatched !== 'park' && unmatched !== 'deny' && unmatched !== 'allow') {
			throw new JobRequestError('--unmatched is park, deny or allow')
		}
		input = { ...input, unmatched }
	}
	const execution = flag(args, 'execution')
	if (execution !== undefined) {
		if (execution !== 'host' && execution !== 'sandbox')
			throw new JobRequestError('--execution is host or sandbox')
		input = { ...input, execution }
	}
	const dirs = args.flags.get('add-dir')
	if (dirs)
		input = {
			...input,
			additionalDirectories: [
				...(input.additionalDirectories ?? []),
				...dirs.map((d) => resolve(d)),
			],
		}
	return input
}

function promptOf(args: ParsedArgs): string {
	const inline = flag(args, 'prompt')
	const file = flag(args, 'prompt-file')
	if (inline && file) throw new JobRequestError('pass --prompt or --prompt-file, not both')
	if (file) return readFileSync(resolve(file), 'utf8')
	if (inline) return inline
	throw new JobRequestError('--prompt (or --prompt-file) is required')
}

function requestFrom(args: ParsedArgs, name: string, base?: ScheduleJob): JobRequest {
	const budget = {
		...(parseCount('--max-iterations', flag(args, 'max-iterations')) !== undefined
			? { maxIterations: parseCount('--max-iterations', flag(args, 'max-iterations')) as number }
			: base
				? { maxIterations: base.budget.maxIterations }
				: {}),
		...(parseCount('--token-budget', flag(args, 'token-budget')) !== undefined
			? { tokenBudget: parseCount('--token-budget', flag(args, 'token-budget')) as number }
			: base
				? { tokenBudget: base.budget.tokenBudget }
				: {}),
		...(parseMs('--timeout', flag(args, 'timeout')) !== undefined
			? { timeoutMs: parseMs('--timeout', flag(args, 'timeout')) as number }
			: base
				? { timeoutMs: base.budget.timeoutMs }
				: {}),
		...(parseMs('--wait-for-provider', flag(args, 'wait-for-provider')) !== undefined
			? {
					waitForProviderMs: parseMs(
						'--wait-for-provider',
						flag(args, 'wait-for-provider'),
					) as number,
				}
			: base
				? { waitForProviderMs: base.budget.waitForProviderMs }
				: {}),
	}
	const approval = parseMs('--approval-ttl', flag(args, 'approval-ttl'))
	const keep = parseCount('--keep-sessions', flag(args, 'keep-sessions'))
	const pauseAfter = parseCount('--pause-after-failures', flag(args, 'pause-after-failures'))
	const model = flag(args, 'model')
	const effort = flag(args, 'effort')
	const tz = flag(args, 'tz') ?? (base?.schedule.kind === 'cron' ? base.schedule.tz : undefined)
	const kindFlag = flag(args, 'kind')
	if (kindFlag !== undefined && !isRunKind(kindFlag)) {
		throw new JobRequestError(`--kind is ${RUN_KINDS.join(', ')}`)
	}
	const runKind: ScheduleRunKind = kindFlag ?? base?.runKind ?? 'agent'
	const shellFlag = flag(args, 'shell')
	if (shellFlag !== undefined && shellFlag !== 'bash' && shellFlag !== 'sh') {
		throw new JobRequestError('--shell is bash or sh')
	}
	const scriptGiven = has(args, 'script') || has(args, 'script-file')
	const scriptBody = scriptGiven ? scriptBodyOf(args) : base?.script?.body
	const shell = shellFlag ?? base?.script?.shell
	if (runKind !== 'agent' && shell === undefined) {
		throw new JobRequestError('--shell bash|sh is required for a script or script+agent job')
	}
	const scriptTimeoutMs =
		parseMs('--script-timeout', flag(args, 'script-timeout')) ?? base?.script?.timeoutMs
	const prompt = ((): string => {
		if (has(args, 'prompt') || has(args, 'prompt-file')) return promptOf(args)
		if (base) return base.prompt
		if (runKind === 'script') return ''
		return promptOf(args)
	})()
	return {
		name,
		prompt,
		...(runKind !== 'agent'
			? {
					runKind,
					script: {
						body: scriptBody ?? '',
						shell: shell as 'bash' | 'sh',
						...(scriptTimeoutMs !== undefined ? { timeoutMs: scriptTimeoutMs } : {}),
					},
				}
			: {}),
		when: flag(args, 'when') ?? '',
		...(!flag(args, 'when') && !flag(args, 'tz') && base ? { spec: base.schedule } : {}),
		folder: resolve(flag(args, 'folder') ?? base?.folder.path ?? process.cwd()),
		...(tz ? { tz } : {}),
		permissions: has(args, 'permissions')
			? permissionInput(args, base?.permissions.browser)
			: base
				? (() => {
						const browser = browserInput(args, base.permissions.browser)
						const unmatched = flag(args, 'unmatched')
						return {
							rules: base.permissions.rules,
							unmatched:
								unmatched === 'park' || unmatched === 'deny' || unmatched === 'allow'
									? unmatched
									: base.permissions.unmatched,
							execution: base.permissions.execution,
							...(base.permissions.additionalDirectories
								? { additionalDirectories: base.permissions.additionalDirectories }
								: {}),
							...(browser ? { browser } : {}),
						}
					})()
				: permissionInput(args),
		budget,
		...(model
			? { model }
			: base
				? { model: `${base.model.provider}${base.model.model ? `/${base.model.model}` : ''}` }
				: {}),
		...(effort ? { effort } : base?.model.effort ? { effort: base.model.effort } : {}),
		...(has(args, 'notify-summary')
			? { includeSummary: true }
			: base
				? { includeSummary: base.notify.includeSummary }
				: {}),
		...(keep !== undefined
			? { keepSessions: keep }
			: base
				? { keepSessions: base.retention.keepSessions }
				: {}),
		...(pauseAfter !== undefined
			? { pauseAfterFailures: pauseAfter }
			: base
				? { pauseAfterFailures: base.failurePolicy.pauseAfterFailures }
				: {}),
		...(approval !== undefined
			? { approvalTtlMs: approval }
			: base
				? { approvalTtlMs: base.approvalTtlMs }
				: {}),
		createdBy: base?.createdBy ?? { surface: 'cli' },
		allowUnattendedHost: has(args, 'allow-unattended-host'),
	}
}

/** Print the preview; ask on a terminal. Returns the confirmation surface, or null when declined. */
async function confirmOnTerminal(
	ctx: CommandContext,
	paths: SchedulePaths,
	job: ScheduleJob,
	args: ParsedArgs,
	verb: string,
	changes: readonly string[] = [],
): Promise<'cli-tty' | 'cli-noninteractive' | null> {
	const layers = readPermissionLayers({ cwd: job.folder.canonical })
	const policy = compileJobPolicy(job.permissions, {
		layers,
		namzuHome: paths.home,
		folder: job.folder,
	})
	if (policy.diagnostics.length > 0) {
		throw new JobRequestError(`permission rules do not compile: ${policy.diagnostics.join('; ')}`)
	}
	// Fail closed before anything is shown: a script that cannot be verified,
	// or that the job's own rules do not allow as one command, never reaches
	// a preview or a confirmation prompt. Re-verified at every `__fire`
	// through the same digest that already re-checks the prompt.
	if (job.runKind && job.runKind !== 'agent' && job.script) {
		const checked = verifyScheduledScript(job.script.body, job.script.shell, policy)
		if (!checked.ok) {
			throw new JobRequestError(
				`the ${job.runKind === 'script' ? 'script' : 'wake-gate script'} was refused: ${checked.reason}`,
			)
		}
	}
	const now = new Date()
	ctx.formatter.info(previewLines(job, policy, now).join('\n'))
	const indented = (text: string) =>
		text
			.split('\n')
			.map((l) => `  ${l}`)
			.join('\n')
	if (job.runKind && job.runKind !== 'agent' && job.script) {
		ctx.formatter.info(
			`${job.runKind === 'script' ? 'Script' : 'Wake-gate script'} (exactly as it will run, ${job.script.shell}, verified clean)\n${indented(job.script.body)}`,
		)
	}
	if (job.prompt.trim()) {
		ctx.formatter.info(
			`${job.runKind === 'script+agent' ? 'Prompt (used only when the wake-gate says wake: true)' : 'Prompt'}\n${indented(job.prompt)}`,
		)
	}
	if (changes.length > 0) ctx.formatter.info(changesBlock(changes).join('\n'))
	if (process.platform === 'darwin' && isPrivacyProtectedFolder(job.folder.canonical)) {
		ctx.formatter.info(
			'Warning: this folder is under Documents, Desktop or Downloads; macOS may block the scheduler from reading it until you grant it Files and Folders access.',
		)
	}
	if (!interactive()) {
		if (!has(args, 'yes')) {
			throw new JobRequestError(
				`no terminal to confirm on; pass --yes to ${verb} the job inert (it waits for confirmation on a terminal or in the TUI)`,
			)
		}
		return 'cli-noninteractive'
	}
	if (has(args, 'yes')) return 'cli-noninteractive'
	const question = verb === 'create' ? 'Create' : verb === 'confirm' ? 'Confirm' : 'Save'
	return (await askYesNo(`${question} this scheduled job?`)) ? 'cli-tty' : null
}

export async function addCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ADD_FLAGS)
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const name = args.positionals[0]
	if (!name) {
		ctx.formatter.error({
			message:
				'usage: namzu schedule add <name> --prompt <text> --when <spec> --permissions <preset|file>',
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const now = new Date()
		const built = buildJob(requestFrom(args, name), { paths, config: ctx.config, now })
		const surface = await confirmOnTerminal(ctx, paths, built, args, 'create')
		if (surface === null) {
			ctx.formatter.info('Not created.')
			return 1
		}
		const job = createJob(paths, confirmJob(built, surface, now, { paused: has(args, 'paused') }))
		appendHistory(paths, job.id, {
			v: 1,
			kind: 'job',
			at: now.toISOString(),
			action: 'created',
			by: surface,
		})
		if (job.state === 'pending-confirmation') {
			ctx.formatter.print({
				text: `Created ${job.name}, held until confirmed: run \`namzu schedule confirm ${job.name}\` on a terminal, or confirm it in the TUI with /schedule.`,
				id: job.id,
				name: job.name,
				state: job.state,
			})
		} else {
			ctx.formatter.print({
				text: `Created ${job.name} (${job.state}). ${job.state === 'active' ? 'The scheduler runs it on time; check with `namzu schedule status`.' : ''}`.trim(),
				id: job.id,
				name: job.name,
				state: job.state,
			})
		}
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return error instanceof JobRequestError ? EXIT_USAGE : 1
	}
}

export async function editCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ADD_FLAGS)
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({
			message:
				args.unknown.length > 0
					? `unknown option: ${args.unknown.join(', ')}`
					: 'usage: namzu schedule edit <job> [flags]',
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const current = findJob(paths, args.positionals[0])
		const now = new Date()
		const rebuilt = buildJob(requestFrom(args, current.name, current), {
			paths,
			config: ctx.config,
			now,
		})
		const candidate = editedJob(current, rebuilt)
		const view = (job: ScheduleJob) =>
			confirmationView(
				job,
				compileJobPolicy(job.permissions, {
					layers: readPermissionLayers({ cwd: job.folder.canonical }),
					namzuHome: paths.home,
				}),
				now,
			)
		const changes = [
			...changesSinceConfirmed(readHistory(paths, current.id)),
			...describeChanges(view(current), view(candidate)),
		]
		const surface = await confirmOnTerminal(ctx, paths, candidate, args, 'save', changes)
		if (surface === null) {
			ctx.formatter.info('Not changed.')
			return 1
		}
		const wasPaused = current.state === 'paused'
		const next = updateJob(paths, current.id, current.revision, () =>
			confirmJob(candidate, surface, now, { paused: wasPaused }),
		)
		appendHistory(paths, next.id, {
			v: 1,
			kind: 'job',
			at: now.toISOString(),
			action: 'edited',
			by: surface,
			...(changes.length > 0 ? { changes } : {}),
		})
		ctx.formatter.print({
			text: `Saved ${next.name} (${next.state}).`,
			id: next.id,
			state: next.state,
		})
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return error instanceof JobRequestError ? EXIT_USAGE : 1
	}
}

export async function confirmCommand(
	ctx: CommandContext,
	argv: readonly string[],
): Promise<number> {
	const args = parseArgs(argv, ['home', 'paused!'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: 'usage: namzu schedule confirm <job> [--paused]' })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	if (!interactive()) {
		ctx.formatter.error({
			message:
				'confirming a job needs a terminal (or the TUI’s /schedule): a confirmation is a person’s, not a script’s',
		})
		return EXIT_USAGE
	}
	try {
		const current = findJob(paths, args.positionals[0])
		const surface = await confirmOnTerminal(
			ctx,
			paths,
			current,
			args,
			'confirm',
			changesSinceConfirmed(readHistory(paths, current.id)),
		)
		if (surface !== 'cli-tty') {
			ctx.formatter.info('Not confirmed.')
			return 1
		}
		const now = new Date()
		const next = updateJob(paths, current.id, current.revision, (job) =>
			confirmJob(job, 'cli-tty', now, { paused: has(args, 'paused') }),
		)
		appendHistory(paths, next.id, {
			v: 1,
			kind: 'job',
			at: now.toISOString(),
			action: 'confirmed',
			by: 'cli-tty',
		})
		ctx.formatter.print({ text: `Confirmed ${next.name} (${next.state}).`, state: next.state })
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return error instanceof JobRequestError ? EXIT_USAGE : 1
	}
}
