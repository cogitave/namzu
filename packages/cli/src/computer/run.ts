/**
 * `namzu computer status | setup | stop-idle`: the Windows Pal computer setup
 * from a terminal. The agent runtime never calls this; setup runs only when a
 * person asks for it here, or when Namzu Desktop drives `--json`.
 */
import { createInterface } from 'node:readline'
import type * as SetupModule from '@namzu/sandbox/local-virtual-computer/setup'
import type {
	WslcImageManifest,
	WslcReadiness,
	WslcSetupPlan,
	WslcSetupProgress,
	WslcSetupResult,
} from '@namzu/sandbox/local-virtual-computer/setup'
import {
	EXIT_FAIL,
	EXIT_INTERNAL_ERROR,
	EXIT_NEEDS_CONSENT,
	EXIT_OK,
	EXIT_UNAVAILABLE,
	EXIT_USAGE,
} from '../exit-codes.js'
import {
	DEFAULT_PAL_COMPUTER_IMAGE,
	type PalComputerBundle,
	PalComputerBundleError,
	readPalComputerBundle,
} from './bundle.js'
import {
	AFTER_RESTART_SENTENCE,
	NOT_WINDOWS_SENTENCE,
	NO_MACHINE_SENTENCE,
	planSentence,
	progressLine,
	readinessSentence,
	resultSentence,
} from './sentences.js'

/** Version of the `--json` field names below; raised only by a breaking change. */
export const COMPUTER_JSON_VERSION = 1

export const COMPUTER_HELP = [
	'Usage: namzu computer <command> [options]',
	'',
	'  status [--json] [--bundle <dir>]',
	'  setup [--json] [--plan <id>] [--yes] [--bundle <dir>]',
	'  stop-idle [--json]',
	'',
	'Pal computers on Windows run on Microsoft’s Linux container support. status says whether this PC',
	'is ready; setup installs what is missing after you agree; stop-idle shuts the idle Linux machine down.',
	'--bundle <dir> (or NAMZU_PAL_COMPUTER_BUNDLE) names the folder that comes with the Pal computer.',
	'setup asks "Continue? [y/N]". Without a terminal it prints the plan and exits 75 unless --yes or --plan is given.',
	'--json prints one JSON object per line, for Namzu Desktop; setup --json needs --plan <id> as the consent.',
].join('\n')

type SetupApi = typeof SetupModule

export interface ComputerDeps {
	readonly platform: NodeJS.Platform
	readonly env: NodeJS.ProcessEnv
	readonly loadSetup: () => Promise<SetupApi>
	readonly out: (text: string) => void
	readonly err: (text: string) => void
	readonly interactive: boolean
	readonly ask: (question: string) => Promise<string>
	readonly now: () => Date
	readonly signal?: AbortSignal
}

interface Parsed {
	readonly verb: 'status' | 'setup' | 'stop-idle'
	readonly json: boolean
	readonly yes: boolean
	readonly plan: string | undefined
	readonly bundle: string | undefined
}

function parse(args: readonly string[]): Parsed | string {
	const [verb, ...rest] = args
	if (verb !== 'status' && verb !== 'setup' && verb !== 'stop-idle')
		return 'Choose status, setup or stop-idle. namzu computer --help lists the options.'
	let json = false
	let yes = false
	let plan: string | undefined
	let bundle: string | undefined
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (arg === '--json') json = true
		else if (arg === '--yes' && verb === 'setup') yes = true
		else if (
			(arg === '--plan' && verb === 'setup') ||
			(arg === '--bundle' && verb !== 'stop-idle')
		) {
			const value = rest[++i]
			if (value === undefined || value.startsWith('--')) return `Expected one value for ${arg}.`
			if (arg === '--plan') plan = value
			else bundle = value
		} else return `namzu computer ${verb} does not take ${arg}.`
	}
	return { verb, json, yes, plan, bundle }
}

function emit(deps: ComputerDeps, line: Record<string, unknown>): void {
	deps.out(`${JSON.stringify({ version: COMPUTER_JSON_VERSION, ...line })}\n`)
}

function say(deps: ComputerDeps, text: string): void {
	deps.out(`${text}\n`)
}

function unsupportedReadiness(deps: ComputerDeps, imageRef: string): WslcReadiness {
	return {
		state: 'unsupported',
		unsupportedReason: 'platform',
		policy: { allowWsl: true, allowWslContainer: true },
		components: {
			virtualMachinePlatform: 'unknown',
			wslOptionalComponent: 'unknown',
			hypervisorPresent: 'unknown',
		},
		wsl: {},
		image: { ref: imageRef, loaded: false },
		checkedAt: deps.now().toISOString(),
	}
}

const UNSUPPORTED_PLAN: WslcSetupPlan = {
	id: 'unsupported',
	state: 'unsupported',
	steps: [],
	elevationPrompts: 0,
	mayRequireRestart: false,
	blocked: 'unsupported',
}

function resolveBundle(parsed: Parsed, deps: ComputerDeps): PalComputerBundle | undefined {
	return readPalComputerBundle(parsed.bundle ?? deps.env.NAMZU_PAL_COMPUTER_BUNDLE)
}

async function inspectAndPlan(
	parsed: Parsed,
	deps: ComputerDeps,
): Promise<{ readiness: WslcReadiness; plan: WslcSetupPlan; bundle?: PalComputerBundle }> {
	const bundle = resolveBundle(parsed, deps)
	const imageRef = bundle?.imageRef ?? DEFAULT_PAL_COMPUTER_IMAGE
	if (deps.platform !== 'win32')
		return { readiness: unsupportedReadiness(deps, imageRef), plan: UNSUPPORTED_PLAN, bundle }
	const setup = await deps.loadSetup()
	const readiness = await setup.inspectWslcReadiness({
		imageRef,
		...(bundle ? { bundledManifestPath: bundle.manifestPath } : {}),
		...(deps.signal ? { signal: deps.signal } : {}),
	})
	const plan = setup.planWslcSetup(readiness, {
		...(bundle ? { manifest: bundle.manifest as unknown as WslcImageManifest } : {}),
	})
	return { readiness, plan, bundle }
}

async function status(parsed: Parsed, deps: ComputerDeps): Promise<number> {
	const { readiness, plan } = await inspectAndPlan(parsed, deps)
	if (parsed.json) emit(deps, { readiness, plan })
	else say(deps, readinessSentence(readiness, plan))
	return EXIT_OK
}

function exitFor(result: WslcSetupResult): number {
	switch (result.outcome) {
		case 'ready':
		case 'restart-required':
			return EXIT_OK
		case 'blocked':
			return EXIT_UNAVAILABLE
		default:
			return EXIT_FAIL
	}
}

async function runPlan(
	parsed: Parsed,
	deps: ComputerDeps,
	planId: string,
	bundle: PalComputerBundle | undefined,
): Promise<number> {
	const setup = await deps.loadSetup()
	const onProgress = (progress: WslcSetupProgress) => {
		if (parsed.json) emit(deps, { progress })
		else {
			const line = progressLine(progress)
			if (line) say(deps, line)
		}
	}
	const result = await setup.runWslcSetup(
		{ planId, approvedAt: deps.now().toISOString() },
		{
			imageRef: bundle?.imageRef ?? DEFAULT_PAL_COMPUTER_IMAGE,
			...(bundle ? { bundledManifestPath: bundle.manifestPath } : {}),
			onProgress,
			...(deps.signal ? { signal: deps.signal } : {}),
		},
	)
	if (parsed.json) {
		emit(deps, { result })
		return exitFor(result)
	}
	const text = resultSentence(result)
	if (result.outcome === 'ready' || result.outcome === 'restart-required') say(deps, text.sentence)
	else deps.err(`${text.sentence}\n`)
	if (text.details) deps.err(`Details: ${text.details}\n`)
	return exitFor(result)
}

async function setupCommand(parsed: Parsed, deps: ComputerDeps): Promise<number> {
	if (parsed.json) {
		if (parsed.plan === undefined) {
			emit(deps, { error: { code: 'plan-required' } })
			return EXIT_USAGE
		}
		if (deps.platform !== 'win32') {
			emit(deps, { result: { outcome: 'blocked', blocked: 'unsupported' } })
			return EXIT_UNAVAILABLE
		}
		return runPlan(parsed, deps, parsed.plan, resolveBundle(parsed, deps))
	}
	if (deps.platform !== 'win32') {
		deps.err(`${NOT_WINDOWS_SENTENCE}\n`)
		return EXIT_UNAVAILABLE
	}
	const { readiness, plan, bundle } = await inspectAndPlan(parsed, deps)
	if (plan.blocked) {
		deps.err(`${planSentence(plan)}\n`)
		return EXIT_UNAVAILABLE
	}
	if (readiness.state === 'ready' || plan.steps.length === 0) {
		say(deps, readinessSentence(readiness, plan))
		return EXIT_OK
	}
	say(deps, planSentence(plan))
	// A restart comes first and Windows does it: there is nothing to confirm yet.
	if (readiness.state === 'restart-pending') {
		// Steps that follow the restart do not run by themselves unless the
		// sign-in entry was registered, so say what to do afterwards.
		if (plan.steps.some((step) => step.kind !== 'restart')) say(deps, AFTER_RESTART_SENTENCE)
		return EXIT_OK
	}
	if (parsed.plan !== undefined && parsed.plan !== plan.id) {
		deps.err(`${resultSentence({ outcome: 'plan-changed', plan }).sentence}\n`)
		return EXIT_FAIL
	}
	if (!parsed.yes && parsed.plan === undefined) {
		if (!deps.interactive) {
			deps.err('Run namzu computer setup --yes to continue.\n')
			return EXIT_NEEDS_CONSENT
		}
		const answer = (await deps.ask('Continue? [y/N] ')).trim().toLowerCase()
		if (answer !== 'y' && answer !== 'yes') {
			say(deps, 'Nothing was changed.')
			return EXIT_OK
		}
	}
	return runPlan(parsed, deps, plan.id, bundle)
}

async function stopIdle(parsed: Parsed, deps: ComputerDeps): Promise<number> {
	let outcome: 'stopped' | 'busy' | 'not-running' = 'not-running'
	if (deps.platform === 'win32') {
		const setup = await deps.loadSetup()
		outcome = (await setup.stopIdleWslcSession({ ...(deps.signal ? { signal: deps.signal } : {}) }))
			.outcome
	}
	if (parsed.json) {
		emit(deps, { outcome })
		return EXIT_OK
	}
	if (deps.platform !== 'win32') say(deps, NO_MACHINE_SENTENCE)
	else if (outcome === 'stopped')
		say(deps, 'The Linux machine for Pal computers was stopped to free memory.')
	else if (outcome === 'busy') say(deps, 'A Pal computer is still running, so nothing was stopped.')
	else say(deps, 'The Linux machine for Pal computers was not running.')
	return EXIT_OK
}

export async function runComputerCommand(
	args: readonly string[],
	deps: ComputerDeps,
): Promise<number> {
	const parsed = parse(args)
	if (typeof parsed === 'string') {
		deps.err(`${parsed}\n`)
		return EXIT_USAGE
	}
	try {
		if (parsed.verb === 'status') return await status(parsed, deps)
		if (parsed.verb === 'setup') return await setupCommand(parsed, deps)
		return await stopIdle(parsed, deps)
	} catch (error) {
		const bundleProblem = error instanceof PalComputerBundleError
		const message = bundleProblem ? error.message : 'Could not check this PC for Pal computers.'
		const code = error instanceof PalComputerBundleError ? EXIT_USAGE : EXIT_INTERNAL_ERROR
		if (parsed.json)
			emit(deps, { error: { code: bundleProblem ? 'bundle-unreadable' : 'check-failed' } })
		else {
			deps.err(`${message}\n`)
			if (!bundleProblem)
				deps.err(`Details: ${error instanceof Error ? error.message : String(error)}\n`)
		}
		return code
	}
}

/** The real dependencies: this process's terminal, environment and Windows. */
export function realComputerDeps(signal?: AbortSignal): ComputerDeps {
	const specifier = '@namzu/sandbox/local-virtual-computer/setup'
	return {
		platform: process.platform,
		env: process.env,
		// The optional leaf is composed here, never imported by the SDK.
		loadSetup: async () => (await import(specifier)) as SetupApi,
		out: (text) => void process.stdout.write(text),
		err: (text) => void process.stderr.write(text),
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		ask: (question) => askQuestion(question, signal),
		now: () => new Date(),
		...(signal ? { signal } : {}),
	}
}

/**
 * Ask on this process's terminal. Ctrl-C, Ctrl-D, a closed input or an abort
 * answer "" (no), so the person is never left at a prompt that cannot end.
 */
export function askQuestion(
	question: string,
	signal?: AbortSignal,
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input, output })
		let settled = false
		const onAbort = () => finish('')
		const finish = (answer: string) => {
			if (settled) return
			settled = true
			signal?.removeEventListener('abort', onAbort)
			rl.close()
			resolve(answer)
		}
		rl.on('close', () => finish(''))
		rl.on('SIGINT', () => finish(''))
		if (signal?.aborted) return finish('')
		signal?.addEventListener('abort', onAbort, { once: true })
		rl.question(question, (answer) => finish(answer))
	})
}
