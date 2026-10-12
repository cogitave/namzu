import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type {
	WslcReadiness,
	WslcSetupPlan,
	WslcSetupProgress,
	WslcSetupResult,
	WslcSetupStep,
} from '@namzu/sandbox/local-virtual-computer/setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { EXIT_NEEDS_CONSENT, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { type ComputerDeps, askQuestion, runComputerCommand } from './run.js'
import {
	humanBytes,
	humanDuration,
	planSentence,
	progressLine,
	readinessSentence,
	resultSentence,
} from './sentences.js'

const MB = 1024 * 1024

function readiness(
	state: WslcReadiness['state'],
	extra: Partial<WslcReadiness> = {},
): WslcReadiness {
	return {
		state,
		policy: { allowWsl: true, allowWslContainer: true },
		components: {
			virtualMachinePlatform: true,
			wslOptionalComponent: 'not-needed',
			hypervisorPresent: true,
		},
		wsl: {},
		image: { ref: 'namzu-local-computer:2', loaded: false },
		checkedAt: '2026-10-12T10:00:00.000Z',
		...extra,
	}
}

const step = (kind: WslcSetupStep['kind'], extra: Partial<WslcSetupStep> = {}): WslcSetupStep => ({
	kind,
	elevated: kind === 'install-wsl' || kind === 'enable-windows-features',
	estimatedSeconds: 60,
	mayRequireRestart: kind === 'install-wsl',
	...extra,
})

function plan(
	state: WslcSetupPlan['state'],
	steps: WslcSetupStep[],
	extra: Partial<WslcSetupPlan> = {},
): WslcSetupPlan {
	return {
		id: 'plan-1',
		state,
		steps,
		elevationPrompts: steps.some((s) => s.elevated) ? 1 : 0,
		mayRequireRestart: steps.some((s) => s.mayRequireRestart),
		...extra,
	}
}

const WSL_MISSING_PLAN = plan('wsl-missing', [
	step('download-wsl', { downloadBytes: 350 * MB, estimatedSeconds: 120 }),
	step('install-wsl', { estimatedSeconds: 90 }),
	step('load-image', { diskBytes: 1200 * MB, estimatedSeconds: 60 }),
])

describe('sentences', () => {
	it('humanises sizes and times', () => {
		expect(humanBytes(0)).toBe('less than 1 MB')
		expect(humanBytes(42 * MB)).toBe('42 MB')
		expect(humanBytes(352 * MB)).toBe('350 MB')
		expect(humanBytes(1.26 * 1024 * MB)).toBe('1.3 GB')
		expect(humanDuration(20)).toBe('about 1 minute')
		expect(humanDuration(300)).toBe('about 5 minutes')
	})

	it('says one sentence per readiness state', () => {
		const empty = plan('ready', [])
		const cases: [WslcReadiness, WslcSetupPlan, string][] = [
			[readiness('ready'), empty, 'This PC is ready for Pal computers.'],
			[
				readiness('wsl-missing'),
				WSL_MISSING_PLAN,
				'Windows needs to add Linux support once (about 350 MB). Run namzu computer setup.',
			],
			[
				readiness('virtualization-off'),
				plan('virtualization-off', [], { blocked: 'virtualization-off' }),
				"This PC has virtualization switched off. Turn on Intel VT-x or AMD-V in the PC's startup settings, then run namzu computer status again.",
			],
			[
				readiness('blocked-by-policy'),
				plan('blocked-by-policy', [], { blocked: 'blocked-by-policy' }),
				'Your organisation does not allow the Linux support Pal computers need on this PC. Ask your IT team to allow it.',
			],
			[
				readiness('unsupported', { unsupportedReason: 'windows-build' }),
				plan('unsupported', [], { blocked: 'unsupported' }),
				'This version of Windows cannot run a Pal computer.',
			],
			[
				readiness('unsupported', { unsupportedReason: 'architecture' }),
				plan('unsupported', [], { blocked: 'unsupported' }),
				"This PC's processor type is not supported for Pal computers yet.",
			],
			[
				readiness('unsupported', { unsupportedReason: 'platform' }),
				plan('unsupported', [], { blocked: 'unsupported' }),
				'Pal computers on this system use Docker or Podman. Setup is automatic only on Windows.',
			],
			[
				readiness('restart-pending'),
				plan('restart-pending', []),
				'Restart your PC to finish setting up Pal computers, then run namzu computer status again.',
			],
			[
				readiness('sdk-mismatch'),
				plan('sdk-mismatch', [], { blocked: 'sdk-mismatch' }),
				"Namzu needs an update to work with this version of Windows' Linux support.",
			],
			[
				readiness('wsl-outdated'),
				plan('wsl-outdated', [step('download-wsl', { downloadBytes: 370 * MB })]),
				'Windows needs to update its Linux support (about 370 MB). Run namzu computer setup.',
			],
			[
				readiness('platform-off'),
				plan('platform-off', [step('enable-windows-features')]),
				'Windows needs to turn on a feature for Linux support. Run namzu computer setup.',
			],
			[
				readiness('image-missing'),
				plan('image-missing', [step('load-image')]),
				'The Pal computer is not on this PC yet. Run namzu computer setup.',
			],
			[
				readiness('image-missing'),
				plan('image-missing', [], { blocked: 'image-unavailable' }),
				'The Pal computer that should come with Namzu is missing from this copy. Reinstall Namzu to get it.',
			],
		]
		for (const [r, p, sentence] of cases) expect(readinessSentence(r, p)).toBe(sentence)
	})

	it('formats the plan with size, minutes, permission and restart clauses', () => {
		expect(planSentence(WSL_MISSING_PLAN)).toBe(
			'To set up Pal computers, Namzu will download Linux support, install Linux support and add the Pal computer. It downloads about 350 MB. This takes about 5 minutes. Windows will ask your permission once. Your PC may need to restart afterwards.',
		)
		expect(planSentence(plan('image-missing', [step('load-image')]))).toBe(
			'To set up Pal computers, Namzu will add the Pal computer. This takes about 1 minute. Windows will not ask for permission.',
		)
	})

	it('words progress lines and results without codes', () => {
		expect(progressLine({ step: 'install-wsl', phase: 'started' })).toBe(
			'Installing Linux support...',
		)
		expect(
			progressLine({ step: 'download-wsl', phase: 'progress', done: 5, total: 10, unit: 'bytes' }),
		).toBeUndefined()
		expect(progressLine({ step: 'install-wsl', phase: 'finished', result: 'ok' })).toBeUndefined()
		expect(resultSentence({ outcome: 'ready' }).sentence).toBe('The Pal computer is ready.')
		expect(resultSentence({ outcome: 'needs-administrator' }).sentence).toBe(
			'Setup needs an administrator. Ask one to approve, or try again.',
		)
		const failed = resultSentence({
			outcome: 'failed',
			step: 'download-wsl',
			code: 'download-failed',
			detail: 'connection reset',
		})
		expect(failed.sentence).toBe('Could not download Linux support. Check the internet connection.')
		expect(failed.details).toBe('download-failed: connection reset')
	})
})

describe('namzu computer', () => {
	let root: string
	afterEach(() => removeTempDir(root))

	const setupApi = {
		inspectWslcReadiness: vi.fn(),
		planWslcSetup: vi.fn(),
		runWslcSetup: vi.fn(),
		stopIdleWslcSession: vi.fn(),
	}

	function harness(overrides: Partial<ComputerDeps> = {}) {
		const out: string[] = []
		const err: string[] = []
		const deps: ComputerDeps = {
			platform: 'win32',
			env: {},
			loadSetup: async () => setupApi as unknown as Awaited<ReturnType<ComputerDeps['loadSetup']>>,
			out: (t) => out.push(t),
			err: (t) => err.push(t),
			interactive: true,
			ask: vi.fn(async () => 'y'),
			now: () => new Date('2026-10-12T10:00:00.000Z'),
			...overrides,
		}
		return { deps, out, err }
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-computer-cli-'))
		for (const fn of Object.values(setupApi)) fn.mockReset()
		setupApi.inspectWslcReadiness.mockResolvedValue(readiness('wsl-missing'))
		setupApi.planWslcSetup.mockReturnValue(WSL_MISSING_PLAN)
		setupApi.runWslcSetup.mockResolvedValue({ outcome: 'ready' })
	})

	it('rejects unknown verbs and options as usage errors', async () => {
		for (const args of [
			[],
			['frobnicate'],
			['status', '--yes'],
			['setup', '--plan'],
			['stop-idle', '--bundle', 'x'],
		]) {
			const { deps, err } = harness()
			expect(await runComputerCommand(args, deps)).toBe(EXIT_USAGE)
			expect(err.join('')).not.toBe('')
		}
	})

	it('prints the status sentence, and the readiness and plan as JSON', async () => {
		const human = harness()
		expect(await runComputerCommand(['status'], human.deps)).toBe(0)
		expect(human.out.join('')).toBe(
			'Windows needs to add Linux support once (about 350 MB). Run namzu computer setup.\n',
		)
		const json = harness()
		expect(await runComputerCommand(['status', '--json'], json.deps)).toBe(0)
		const lines = json.out.join('').trimEnd().split('\n')
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0] ?? '')).toEqual({
			version: 1,
			readiness: readiness('wsl-missing'),
			plan: WSL_MISSING_PLAN,
		})
	})

	it('answers off Windows without calling the setup module', async () => {
		const loadSetup = vi.fn()
		const human = harness({ platform: 'linux', loadSetup })
		expect(await runComputerCommand(['status'], human.deps)).toBe(0)
		expect(human.out.join('')).toBe(
			'Pal computers on this system use Docker or Podman. Setup is automatic only on Windows.\n',
		)
		const json = harness({ platform: 'linux', loadSetup })
		await runComputerCommand(['status', '--json'], json.deps)
		const parsed = JSON.parse(json.out.join(''))
		expect(parsed.readiness).toMatchObject({ state: 'unsupported', unsupportedReason: 'platform' })
		const setup = harness({ platform: 'linux', loadSetup })
		expect(await runComputerCommand(['setup'], setup.deps)).toBe(EXIT_UNAVAILABLE)
		expect(setup.err.join('')).toContain('automatic only on Windows')
		expect(loadSetup).not.toHaveBeenCalled()
	})

	it('reads the bundle for the image reference and manifest path', async () => {
		const dir = join(root, 'bundle')
		mkdirSync(dir)
		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify({ imageRef: 'namzu-local-computer:9' }),
		)
		const { deps } = harness({ env: { NAMZU_PAL_COMPUTER_BUNDLE: dir } })
		await runComputerCommand(['status'], deps)
		expect(setupApi.inspectWslcReadiness).toHaveBeenCalledWith({
			imageRef: 'namzu-local-computer:9',
			bundledManifestPath: join(dir, 'manifest.json'),
		})
		setupApi.inspectWslcReadiness.mockClear()
		const flag = harness()
		await runComputerCommand(['status', '--bundle', dir], flag.deps)
		expect(setupApi.inspectWslcReadiness.mock.calls[0]?.[0].imageRef).toBe('namzu-local-computer:9')
		const missing = harness()
		expect(await runComputerCommand(['status', '--bundle', join(root, 'none')], missing.deps)).toBe(
			EXIT_USAGE,
		)
		expect(missing.err.join('')).toContain('manifest.json')
	})

	it('without a bundle it asks about the default image', async () => {
		const { deps } = harness()
		await runComputerCommand(['status'], deps)
		expect(setupApi.inspectWslcReadiness).toHaveBeenCalledWith({
			imageRef: 'namzu-local-computer:2',
		})
	})

	it('asks Continue? and runs only after y, naming the plan it showed', async () => {
		const progress: WslcSetupProgress[] = [
			{ step: 'download-wsl', phase: 'started' },
			{ step: 'download-wsl', phase: 'progress', done: 1, total: 2, unit: 'bytes' },
			{ step: 'download-wsl', phase: 'finished', result: 'ok' },
			{ step: 'load-image', phase: 'started' },
		]
		setupApi.runWslcSetup.mockImplementation(async (_c, options) => {
			for (const p of progress) options.onProgress(p)
			return { outcome: 'ready' }
		})
		const { deps, out } = harness()
		expect(await runComputerCommand(['setup'], deps)).toBe(0)
		expect(deps.ask).toHaveBeenCalledWith('Continue? [y/N] ')
		expect(setupApi.runWslcSetup.mock.calls[0]?.[0]).toEqual({
			planId: 'plan-1',
			approvedAt: '2026-10-12T10:00:00.000Z',
		})
		expect(out.join('')).toBe(
			`${planSentence(WSL_MISSING_PLAN)}\nDownloading Linux support...\nAdding the Pal computer...\nThe Pal computer is ready.\n`,
		)
	})

	it('does nothing on any answer but yes', async () => {
		for (const answer of ['', 'n', 'no', 'maybe']) {
			setupApi.runWslcSetup.mockClear()
			const { deps, out } = harness({ ask: vi.fn(async () => answer) })
			expect(await runComputerCommand(['setup'], deps)).toBe(0)
			expect(setupApi.runWslcSetup).not.toHaveBeenCalled()
			expect(out.join('')).toContain('Nothing was changed.')
		}
	})

	it('without a terminal prints the plan and exits 75 unless --yes or --plan', async () => {
		const stopped = harness({ interactive: false })
		expect(await runComputerCommand(['setup'], stopped.deps)).toBe(EXIT_NEEDS_CONSENT)
		expect(stopped.out.join('')).toBe(`${planSentence(WSL_MISSING_PLAN)}\n`)
		expect(setupApi.runWslcSetup).not.toHaveBeenCalled()
		const yes = harness({ interactive: false })
		expect(await runComputerCommand(['setup', '--yes'], yes.deps)).toBe(0)
		const named = harness({ interactive: false })
		expect(await runComputerCommand(['setup', '--plan', 'plan-1'], named.deps)).toBe(0)
		expect(setupApi.runWslcSetup).toHaveBeenCalledTimes(2)
	})

	it('refuses a --plan id that is not the current plan', async () => {
		const { deps, err } = harness({ interactive: false })
		expect(await runComputerCommand(['setup', '--plan', 'old'], deps)).toBe(1)
		expect(err.join('')).toContain('This PC changed since the plan was shown')
		expect(setupApi.runWslcSetup).not.toHaveBeenCalled()
	})

	it('exits non-zero with the sentence for a blocked plan, and 0 when already ready', async () => {
		setupApi.planWslcSetup.mockReturnValue(
			plan('blocked-by-policy', [], { blocked: 'blocked-by-policy' }),
		)
		const blocked = harness()
		expect(await runComputerCommand(['setup'], blocked.deps)).toBe(EXIT_UNAVAILABLE)
		expect(blocked.err.join('')).toContain('Your organisation does not allow the Linux support')
		setupApi.inspectWslcReadiness.mockResolvedValue(readiness('ready'))
		setupApi.planWslcSetup.mockReturnValue(plan('ready', []))
		const ready = harness()
		expect(await runComputerCommand(['setup'], ready.deps)).toBe(0)
		expect(ready.out.join('')).toBe('This PC is ready for Pal computers.\n')
	})

	it('puts a failure in plain words with a Details line', async () => {
		setupApi.runWslcSetup.mockResolvedValue({
			outcome: 'failed',
			step: 'install-wsl',
			code: 'wsl-install-failed',
		} satisfies WslcSetupResult)
		const { deps, err } = harness()
		expect(await runComputerCommand(['setup', '--yes'], deps)).toBe(1)
		expect(err.join('')).toBe(
			'Windows could not install Linux support.\nDetails: wsl-install-failed\n',
		)
	})

	it('setup --json needs --plan and prints progress lines then one result', async () => {
		const missing = harness()
		expect(await runComputerCommand(['setup', '--json'], missing.deps)).toBe(EXIT_USAGE)
		expect(JSON.parse(missing.out.join(''))).toEqual({
			version: 1,
			error: { code: 'plan-required' },
		})
		expect(setupApi.runWslcSetup).not.toHaveBeenCalled()

		setupApi.runWslcSetup.mockImplementation(async (_c, options) => {
			options.onProgress({ step: 'install-wsl', phase: 'started' })
			options.onProgress({ step: 'install-wsl', phase: 'finished', result: 'restart-required' })
			return { outcome: 'restart-required' }
		})
		const { deps, out } = harness({ interactive: false })
		expect(await runComputerCommand(['setup', '--json', '--plan', 'plan-1'], deps)).toBe(0)
		const lines = out
			.join('')
			.trimEnd()
			.split('\n')
			.map((l) => JSON.parse(l))
		expect(lines).toEqual([
			{ version: 1, progress: { step: 'install-wsl', phase: 'started' } },
			{
				version: 1,
				progress: { step: 'install-wsl', phase: 'finished', result: 'restart-required' },
			},
			{ version: 1, result: { outcome: 'restart-required' } },
		])
		expect(setupApi.runWslcSetup.mock.calls[0]?.[0]).toEqual({
			planId: 'plan-1',
			approvedAt: '2026-10-12T10:00:00.000Z',
		})
		expect(setupApi.inspectWslcReadiness).not.toHaveBeenCalled()
	})

	it('setup --resume-command is handed to the setup run, and only setup takes it', async () => {
		setupApi.runWslcSetup.mockResolvedValue({ outcome: 'restart-required' })
		const { deps } = harness({ interactive: false })
		expect(
			await runComputerCommand(
				['setup', '--json', '--plan', 'plan-1', '--resume-command', '"C:\\Namzu.exe" --continue'],
				deps,
			),
		).toBe(0)
		expect(setupApi.runWslcSetup.mock.calls.at(-1)?.[1]).toMatchObject({
			resumeCommand: '"C:\\Namzu.exe" --continue',
		})
		const other = harness({ interactive: false })
		expect(await runComputerCommand(['status', '--resume-command', 'x'], other.deps)).toBe(64)
	})

	it('hands a resume command whose program path has spaces over byte for byte', async () => {
		setupApi.runWslcSetup.mockResolvedValue({ outcome: 'restart-required' })
		const { deps } = harness({ interactive: false })
		const command =
			'"C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\Namzu\\Namzu.exe" --continue-pal-computer-setup'
		await runComputerCommand(
			['setup', '--json', '--plan', 'plan-1', '--resume-command', command],
			deps,
		)
		expect(setupApi.runWslcSetup.mock.calls.at(-1)?.[1]).toMatchObject({ resumeCommand: command })
	})

	it('setup --json reports a changed plan as a result, with exit 1', async () => {
		setupApi.runWslcSetup.mockResolvedValue({ outcome: 'plan-changed', plan: WSL_MISSING_PLAN })
		const { deps, out } = harness()
		expect(await runComputerCommand(['setup', '--json', '--plan', 'x'], deps)).toBe(1)
		expect(JSON.parse(out.join(''))).toEqual({
			version: 1,
			result: { outcome: 'plan-changed', plan: WSL_MISSING_PLAN },
		})
	})

	it('stop-idle says stopped, busy or not running, and prints the outcome as JSON', async () => {
		const words: Record<string, string> = {
			stopped: 'The Linux machine for Pal computers was stopped to free memory.\n',
			busy: 'A Pal computer is still running, so nothing was stopped.\n',
			'not-running': 'The Linux machine for Pal computers was not running.\n',
		}
		for (const outcome of Object.keys(words)) {
			setupApi.stopIdleWslcSession.mockResolvedValue({ outcome })
			const human = harness()
			expect(await runComputerCommand(['stop-idle'], human.deps)).toBe(0)
			expect(human.out.join('')).toBe(words[outcome])
			const json = harness()
			await runComputerCommand(['stop-idle', '--json'], json.deps)
			expect(JSON.parse(json.out.join(''))).toEqual({ version: 1, outcome })
		}
	})

	it('reports a failure of the setup module in plain words, never JSON prose fields beyond message', async () => {
		setupApi.inspectWslcReadiness.mockRejectedValue(new Error('boom'))
		const human = harness()
		expect(await runComputerCommand(['status'], human.deps)).toBe(70)
		expect(human.err.join('')).toBe('Could not check this PC for Pal computers.\nDetails: boom\n')
		const json = harness()
		expect(await runComputerCommand(['status', '--json'], json.deps)).toBe(70)
		expect(JSON.parse(json.out.join(''))).toEqual({
			version: 1,
			error: { code: 'check-failed' },
		})
		const bundle = harness()
		expect(
			await runComputerCommand(['status', '--json', '--bundle', join(root, 'none')], bundle.deps),
		).toBe(EXIT_USAGE)
		expect(JSON.parse(bundle.out.join(''))).toEqual({
			version: 1,
			error: { code: 'bundle-unreadable' },
		})
	})

	it('stop-idle off Windows says there is nothing to stop', async () => {
		const { deps, out } = harness({ platform: 'linux' })
		expect(await runComputerCommand(['stop-idle'], deps)).toBe(0)
		expect(out.join('')).toBe(
			'There is no Linux machine for Pal computers to stop on this system.\n',
		)
	})

	it('the plan sentence handles every number of Windows prompts', () => {
		const base = plan('wsl-missing', [step('install-wsl')])
		expect(planSentence({ ...base, elevationPrompts: 0 })).toContain(
			'Windows will not ask for permission.',
		)
		expect(planSentence({ ...base, elevationPrompts: 2 as 0 | 1 })).toContain(
			'Windows will ask your permission 2 times.',
		)
	})

	it('treats Ctrl-D at Continue as no, and a PassThrough that ends before an answer settles', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const answer = askQuestion('Continue? [y/N] ', undefined, input, output)
		input.end()
		expect(await answer).toBe('')
		const typed = new PassThrough()
		const pending = askQuestion('Continue? [y/N] ', undefined, typed, new PassThrough())
		typed.write('y\n')
		expect(await pending).toBe('y')
		const controller = new AbortController()
		const aborted = askQuestion(
			'Continue? [y/N] ',
			controller.signal,
			new PassThrough(),
			new PassThrough(),
		)
		controller.abort()
		expect(await aborted).toBe('')
	})

	it('an unanswered prompt changes nothing and exits 0', async () => {
		const { deps, out } = harness({ ask: vi.fn(async () => '') })
		expect(await runComputerCommand(['setup'], deps)).toBe(0)
		expect(out.join('')).toContain('Nothing was changed.')
		expect(setupApi.runWslcSetup).not.toHaveBeenCalled()
	})
})
