/**
 * An agent job's gate, as the person sets it: `schedule add`/`edit` flags,
 * the limits on its timeout, what the static check refuses, how the digest
 * binds it (so a hand-edit of the job file holds the job), and how `show`
 * and `list` say it.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { JobRequestError, buildJob, confirmJob } from '../build.js'
import { addCommand, editCommand } from '../commands/add.js'
import { historyCommand, listCommand, showCommand } from '../commands/list.js'
import {
	DEFAULT_GATE_TIMEOUT_MS,
	GATE_OUTPUT_MAX_CHARS,
	MAX_GATE_TIMEOUT_MS,
	gateEnvironment,
	gateLines,
	gateRefusal,
	runGate,
} from '../gate.js'
import { appendHistory } from '../store/history.js'
import { confirmationHolds, createJob, findJob } from '../store/jobs.js'
import { readState, writeState } from '../store/state.js'
import { type Sandbox, jobRequest, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => {
	__resetCliLoggerForTests()
	sb.cleanup()
})

function noRules(): string {
	const path = join(sb.root, 'no-rules.json')
	writeFileSync(path, JSON.stringify({ rules: {}, unmatched: 'deny' }))
	return path
}

const args = (name: string, ...more: string[]) => [
	name,
	'--home',
	sb.home,
	'--when',
	'every 10m',
	'--folder',
	sb.project,
	'--prompt',
	'Handle what the gate found.',
	'--model',
	'deepseek/deepseek-chat',
	'--permissions',
	noRules(),
	...more,
]

describe('schedule add --gate', () => {
	it('stores the command with the stated default shell and timeout, and shows the exact command', async () => {
		const ctx = recordingContext()
		const code = await addCommand(
			ctx,
			args('queue', '--gate', 'find inbox -type f -mmin -10', '--yes'),
		)
		expect(code).toBe(0)
		const job = findJob(sb.paths, 'queue')
		expect(job.gate).toEqual({
			command: 'find inbox -type f -mmin -10',
			shell: 'sh',
			timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
		})
		expect(DEFAULT_GATE_TIMEOUT_MS).toBe(30_000)
		expect(ctx.out.info.join('\n')).toContain('find inbox -type f -mmin -10')
		expect(ctx.out.info.join('\n')).toContain('exits 0 and prints something')
	})

	it('takes the command from a file, a shell, and a timeout', async () => {
		const file = join(sb.root, 'gate.sh')
		writeFileSync(file, 'ls inbox\n')
		const code = await addCommand(
			recordingContext(),
			args('queue', '--gate-file', file, '--gate-shell', 'bash', '--gate-timeout', '2m', '--yes'),
		)
		expect(code).toBe(0)
		expect(findJob(sb.paths, 'queue').gate).toEqual({
			command: 'ls inbox\n',
			shell: 'bash',
			timeoutMs: 120_000,
		})
	})

	it('refuses a timeout above the hard limit, and names the limit', async () => {
		const ctx = recordingContext()
		const code = await addCommand(
			ctx,
			args('queue', '--gate', 'ls inbox', '--gate-timeout', '6m', '--yes'),
		)
		expect(code).not.toBe(0)
		expect(ctx.out.errors.join('\n')).toContain(`at most ${MAX_GATE_TIMEOUT_MS / 1000} s`)
		expect(() => findJob(sb.paths, 'queue')).toThrow()
	})

	it('refuses --gate-timeout without a gate', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, args('queue', '--gate-timeout', '10s', '--yes'))
		expect(code).not.toBe(0)
		expect(ctx.out.errors.join('\n')).toContain('need a gate')
	})

	it('refuses a gate the floor cannot read, before anything is shown', async () => {
		const ctx = recordingContext()
		const code = await addCommand(
			ctx,
			args('queue', '--gate', "trap 'rm -rf ~/.namzu' EXIT", '--yes'),
		)
		expect(code).not.toBe(0)
		expect(ctx.out.errors.join('\n')).toContain('the gate was refused')
		expect(ctx.out.info.join('\n')).not.toContain('Gate  ')
	})

	it('refuses a gate on a script+agent job, which has its own wake-gate script', async () => {
		const ctx = recordingContext()
		const code = await addCommand(
			ctx,
			args(
				'queue',
				'--kind',
				'script+agent',
				'--script',
				'echo hi',
				'--shell',
				'sh',
				'--gate',
				'ls',
				'--yes',
			),
		)
		expect(code).not.toBe(0)
		expect(ctx.out.errors.join('\n')).toContain('only applies to an agent job')
	})

	it('refuses a gate beside execution in the sandbox', async () => {
		const ctx = recordingContext()
		const perm = join(sb.root, 'sandbox.json')
		writeFileSync(perm, JSON.stringify({ rules: {}, unmatched: 'deny', execution: 'sandbox' }))
		const code = await addCommand(
			ctx,
			args('queue', '--gate', 'ls inbox', '--execution', 'sandbox', '--yes'),
		)
		expect(code).not.toBe(0)
		expect(ctx.out.errors.join('\n')).toContain('not yet supported for a gate')
	})
})

describe('editing a job with a gate', () => {
	async function made(): Promise<void> {
		expect(await addCommand(recordingContext(), args('queue', '--gate', 'ls inbox', '--yes'))).toBe(
			0,
		)
	}

	it('keeps the gate when the edit does not mention it, and changes it when asked', async () => {
		await made()
		expect(
			await editCommand(recordingContext(), [
				'queue',
				'--home',
				sb.home,
				'--when',
				'every 5m',
				'--yes',
			]),
		).toBe(0)
		expect(findJob(sb.paths, 'queue').gate?.command).toBe('ls inbox')
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, [
				'queue',
				'--home',
				sb.home,
				'--gate',
				'ls inbox archive',
				'--gate-timeout',
				'10s',
				'--yes',
			]),
		).toBe(0)
		expect(findJob(sb.paths, 'queue').gate).toEqual({
			command: 'ls inbox archive',
			shell: 'sh',
			timeoutMs: 10_000,
		})
		expect(ctx.out.info.join('\n')).toContain('- Gate  ls inbox')
		expect(ctx.out.info.join('\n')).toContain('+ Gate  ls inbox archive')
	})

	it('drops the gate with --no-gate', async () => {
		await made()
		expect(
			await editCommand(recordingContext(), ['queue', '--home', sb.home, '--no-gate', '--yes']),
		).toBe(0)
		expect(findJob(sb.paths, 'queue').gate).toBeUndefined()
	})
})

describe('the job file and the confirmation digest', () => {
	it('a gate written into the job file by hand holds the job until a person confirms it', async () => {
		const built = buildJob(jobRequest(sb), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})
		expect(built.gate).toBeUndefined()
		const confirmed = createJob(
			sb.paths,
			confirmJob(built, 'cli-tty', new Date(), { paths: sb.paths }),
		)
		// What a person does with an editor: add a gate to the stored file.
		const file = sb.paths.job(confirmed.id)
		writeFileSync(
			file,
			JSON.stringify({
				...JSON.parse(readFileSync(file, 'utf8')),
				v: 3,
				gate: { command: 'echo changed', shell: 'sh', timeoutMs: 1000 },
			}),
		)
		const held = findJob(sb.paths, confirmed.name)
		expect(held.gate?.command).toBe('echo changed')
		expect(confirmationHolds(held)).toBe(false)
		expect(confirmationHolds(confirmed)).toBe(true)
	})

	it('changing only the gate command invalidates the confirmation', () => {
		const build = (command: string) => {
			const job = buildJob(jobRequest(sb, { gate: { command } }), {
				paths: sb.paths,
				config: {},
				now: new Date(),
				osHome: sb.osHome,
			})
			return confirmJob(job, 'cli-tty', new Date(), { paths: sb.paths })
		}
		const a = build('ls inbox')
		const b = build('ls other')
		expect(a.confirmation?.digest).not.toBe(b.confirmation?.digest)
		expect(confirmationHolds({ ...a, gate: b.gate })).toBe(false)
	})

	it('a job without a gate keeps the digest it had before gates existed', () => {
		const plain = buildJob(jobRequest(sb), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})
		expect(plain.v).toBe(1)
		expect('gate' in plain).toBe(false)
	})

	it('buildJob refuses an empty command and a gate on a script job', () => {
		const ctx = { paths: sb.paths, config: {}, now: new Date(), osHome: sb.osHome }
		expect(() => buildJob(jobRequest(sb, { gate: { command: '  ' } }), ctx)).toThrow(
			JobRequestError,
		)
		expect(() =>
			buildJob(
				jobRequest(sb, {
					runKind: 'script',
					script: { body: 'true', shell: 'sh' },
					gate: { command: 'true' },
				}),
				ctx,
			),
		).toThrow(/only applies to an agent job/)
	})
})

describe('show and list', () => {
	it('show prints the exact gate command; list marks the job', async () => {
		expect(await addCommand(recordingContext(), args('queue', '--gate', 'ls inbox', '--yes'))).toBe(
			0,
		)
		const show = recordingContext()
		expect(await showCommand(show, ['queue', '--home', sb.home])).toBe(0)
		const text = String(show.out.printed[0])
		expect(text).toContain('Gate        runs first (sh, up to 30 s)')
		expect(text).toContain('│ ls inbox')
		const list = recordingContext()
		expect(await listCommand(list, ['--home', sb.home])).toBe(0)
		expect(String(list.out.printed[0])).toContain('[gate]')
	})
})

describe('where a skipped run is listed', () => {
	it('list, show and history all say why in plain words', async () => {
		expect(await addCommand(recordingContext(), args('queue', '--gate', 'ls inbox', '--yes'))).toBe(
			0,
		)
		const job = findJob(sb.paths, 'queue')
		const at = '2026-09-23T03:10:00.000Z'
		appendHistory(sb.paths, job.id, {
			v: 3,
			kind: 'run',
			at,
			runId: crypto.randomUUID(),
			key: '1',
			trigger: 'scheduled',
			startedAt: at,
			endedAt: at,
			status: 'skipped',
			skipKind: 'exit',
			reason: 'the gate exited with 3',
			exitCode: 0,
		})
		writeState(sb.paths, {
			...readState(sb.paths, job.id),
			counters: { runs: 1, failures: 0, failureStreak: 0, skips: 1 },
			lastRun: {
				runId: 'r',
				status: 'skipped',
				endedAt: at,
				reason: 'the gate exited with 3',
			},
		})
		const list = recordingContext()
		await listCommand(list, ['--home', sb.home])
		expect(String(list.out.printed[0])).toContain('last skipped (the gate exited with 3)')
		const show = recordingContext()
		await showCommand(show, ['queue', '--home', sb.home])
		expect(String(show.out.printed[0])).toContain('run skipped: the gate exited with 3')
		expect(String(show.out.printed[0])).toContain('Skipped     1 run so far')
		const history = recordingContext()
		await historyCommand(history, ['queue', '--home', sb.home])
		expect(String(history.out.printed[0])).toContain('run skipped: the gate exited with 3')
	})
})

describe('the environment and the output limit', () => {
	it('drops credential-shaped keys and keeps the rest', () => {
		const env = gateEnvironment(
			{ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', GITHUB_TOKEN: 'z', PATH: '/bin', LANG: 'C' },
			'/home/x/.namzu',
		)
		expect(env).toEqual({ PATH: '/bin', LANG: 'C', NAMZU_HOME: '/home/x/.namzu' })
	})

	it('keeps output of exactly the limit whole and cuts one character more', async () => {
		const gate = { command: 'x', shell: 'sh' as const, timeoutMs: 1000 }
		const run = async (n: number) =>
			runGate(gate, {
				cwd: sb.project,
				env: {},
				runner: async () => ({
					stdout: 'a'.repeat(n),
					stderr: '',
					exitCode: 0,
					timedOut: false,
				}),
			})
		const whole = await run(GATE_OUTPUT_MAX_CHARS)
		expect(whole).toMatchObject({ run: true, cut: false })
		const cut = await run(GATE_OUTPUT_MAX_CHARS + 1)
		expect(cut).toMatchObject({ run: true, cut: true })
		expect(cut.run && cut.output).toContain('...(cut:')
	})
})

describe('a gate that was damaged in the job file, or ended abnormally', () => {
	const ok = { command: 'x', shell: 'sh' as const, timeoutMs: 1000 }
	const never = async () => {
		throw new Error('the runner must not be reached')
	}
	it.each([
		['a huge timeout', { ...ok, timeoutMs: 1e12 }],
		['a negative timeout', { ...ok, timeoutMs: -5 }],
		['a missing timeout', { ...ok, timeoutMs: undefined }],
		['a text timeout', { ...ok, timeoutMs: 'x' }],
		['a command that is not text', { ...ok, command: 42 }],
		['an unknown shell', { ...ok, shell: 'zsh' }],
	])('does not run a gate with %s, and says so as a start failure', async (_n, bad) => {
		const out = await runGate(bad as never, { cwd: sb.project, env: {}, runner: never as never })
		expect(out).toMatchObject({ run: false, kind: 'start' })
		expect(out.run === false && out.reason).toContain('the gate could not start')
		expect(
			gateRefusal(
				{
					gate: bad as never,
					permissions: {} as never,
					folder: { path: sb.project, canonical: sb.project },
				},
				[],
				sb.home,
			),
		).toContain('the gate was refused')
		expect(() => gateLines(bad as never)).not.toThrow()
	})

	it('reports output past the limit as its own reason, not as a start failure', async () => {
		const out = await runGate(ok, {
			cwd: sb.project,
			env: {},
			runner: async () => ({
				stdout: 'a',
				stderr: '',
				exitCode: null,
				timedOut: false,
				outputOverflow: true,
			}),
		})
		expect(out).toMatchObject({ run: false, kind: 'abnormal' })
		expect(out.run === false && out.reason).toBe(
			'the gate printed too much and was ended (more than 10 MB)',
		)
	})

	it('reports a signal as its own reason, not as a start failure', async () => {
		const out = await runGate(ok, {
			cwd: sb.project,
			env: {},
			runner: async () => ({
				stdout: 'hi',
				stderr: '',
				exitCode: null,
				timedOut: false,
				signal: 'SIGKILL',
			}),
		})
		expect(out).toMatchObject({
			run: false,
			kind: 'abnormal',
			reason: 'the gate was ended by SIGKILL',
		})
	})

	it('does not cut a surrogate pair in half', async () => {
		const out = await runGate(ok, {
			cwd: sb.project,
			env: {},
			runner: async () => ({
				stdout: `${'a'.repeat(GATE_OUTPUT_MAX_CHARS - 1)}\u{1F600}more`,
				stderr: '',
				exitCode: 0,
				timedOut: false,
			}),
		})
		expect(out.run && out.output.startsWith('a'.repeat(GATE_OUTPUT_MAX_CHARS - 1))).toBe(true)
		expect(out.run && /[\uD800-\uDBFF]/.test(out.output.replace(/\u{1F600}/gu, ''))).toBe(false)
	})
})
