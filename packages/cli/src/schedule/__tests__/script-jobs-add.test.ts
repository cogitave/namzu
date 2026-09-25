/**
 * `schedule add`/`edit` for `script`/`script+agent` jobs: the `--kind`,
 * `--script`/`--script-file`, `--shell` and `--script-timeout` flags, and the
 * static check refusing a bad script before any preview or confirmation is
 * shown (fail closed at creation time, not just at `__fire`).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostCommandShell } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPreferences } from '../../integrations/providers/preferences.js'
import { __resetCliLoggerForTests } from '../../logging.js'
import { confirmJob } from '../build.js'
import { addCommand, editCommand } from '../commands/add.js'
import { runNowCommand } from '../commands/lifecycle.js'
import { showCommand } from '../commands/list.js'
import { readRunResult } from '../fire/result.js'
import { confirmationHolds, findJob, updateJob } from '../store/jobs.js'
import { readState } from '../store/state.js'
import { type Sandbox, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => {
	__resetCliLoggerForTests()
	sb.cleanup()
})

const base = (sb: Sandbox) => ['--home', sb.home, '--when', 'every 1m', '--folder', sb.project]

let permFile = 0
/** A `--permissions` JSON file, since the flag takes a preset name or a path, never inline JSON. */
function permissions(sb: Sandbox, rules: unknown, unmatched = 'deny'): string {
	const path = join(sb.root, `perm-${permFile++}.json`)
	writeFileSync(path, JSON.stringify({ rules, unmatched }))
	return path
}

describe('schedule add --kind script', () => {
	it.skipIf(process.platform === 'win32')(
		'refuses a requested shell that is not installed before writing a job',
		async () => {
			const previous = process.env.NAMZU_BASH_SHELL
			process.env.NAMZU_BASH_SHELL = join(sb.root, 'missing', 'sh')
			try {
				const ctx = recordingContext()
				const code = await addCommand(ctx, [
					'missing-shell',
					...base(sb),
					'--kind',
					'script',
					'--script',
					'echo should-not-run',
					'--shell',
					'sh',
					'--permissions',
					permissions(sb, {}),
					'--yes',
				])
				expect(code).not.toBe(0)
				expect(ctx.out.errors.join('\n')).toMatch(/requested sh shell is not executable/)
				expect(() => findJob(sb.paths, 'missing-shell')).toThrow(/No scheduled job/)
			} finally {
				if (previous === undefined) delete process.env.NAMZU_BASH_SHELL
				else process.env.NAMZU_BASH_SHELL = previous
			}
		},
	)

	it('adds and runs a pure script with no configured provider or stored model', async () => {
		expect(readPreferences(sb.home).status).toBe('missing')
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'no-provider',
			'--home',
			sb.home,
			'--when',
			'every 1m',
			'--folder',
			sb.project,
			'--kind',
			'script',
			'--script',
			'echo no-provider',
			'--shell',
			hostCommandShell().dialect,
			'--permissions',
			permissions(sb, {}),
			'--yes',
		])
		if (code !== 0) throw new Error(ctx.out.errors.join('\n'))
		const pending = findJob(sb.paths, 'no-provider')
		expect(pending.state).toBe('pending-confirmation')
		expect(pending).not.toHaveProperty('model')
		expect(JSON.parse(readFileSync(sb.paths.job(pending.id), 'utf8'))).not.toHaveProperty('model')
		expect(ctx.out.info.join('\n')).toContain('Model       none (script only)')
		expect(ctx.out.info.join('\n')).toContain('Network     THIS RUN CAN REACH THE NETWORK')
		expect(ctx.out.info.join('\n')).toContain(
			'the scheduled-run floor and every deny rule apply to this script',
		)
		expect(ctx.out.info.join('\n')).not.toContain('Approvals   ')
		// The noninteractive CLI correctly leaves the job inert. Record the
		// same operator confirmation as the terminal command before run-now.
		const active = updateJob(sb.paths, pending.id, pending.revision, (job) =>
			confirmJob(job, 'cli-tty', new Date()),
		)
		expect(active).not.toHaveProperty('model')
		const run = recordingContext()
		expect(await runNowCommand(run, ['no-provider', '--home', sb.home])).toBe(0)
		const last = readState(sb.paths, active.id).lastRun
		expect(last?.status).toBe('completed')
		const result = readRunResult(sb.paths, active.id, last?.runId as string)
		expect(result?.scriptOutput?.stdout.trim()).toBe('no-provider')
		expect(result?.sessionId).toBeUndefined()
		expect(result?.usage).toBeUndefined()
		const show = recordingContext()
		expect(await showCommand(show, ['no-provider', '--home', sb.home])).toBe(0)
		expect(String(show.out.printed[0])).toContain('Model       none (script only)')
		expect(String(show.out.printed[0])).toContain('Budget      0 tokens; script timeout')
		const json = recordingContext()
		expect(await showCommand(json, ['no-provider', '--home', sb.home, '--json'])).toBe(0)
		expect(JSON.parse(String(json.out.printed[0])).job).not.toHaveProperty('model')
		const edited = recordingContext()
		expect(
			await editCommand(edited, [
				'no-provider',
				'--home',
				sb.home,
				'--script',
				'echo edited',
				'--yes',
			]),
		).toBe(0)
		expect(findJob(sb.paths, 'no-provider')).not.toHaveProperty('model')
		const before = findJob(sb.paths, 'no-provider')
		for (const [flag, value] of [
			['--max-iterations', '5'],
			['--token-budget', '50000'],
			['--timeout', '2m'],
			['--wait-for-provider', '2m'],
			['--approval-ttl', '2d'],
			['--keep-sessions', '5'],
		]) {
			const refused = recordingContext()
			expect(
				await editCommand(refused, ['no-provider', '--home', sb.home, flag, value, '--yes']),
				flag,
			).toBe(64)
			expect(refused.out.errors.join(' '), flag).toContain(flag)
		}
		expect(findJob(sb.paths, 'no-provider').revision).toBe(before.revision)
		for (const kind of ['agent', 'script+agent']) {
			const refused = recordingContext()
			expect(
				await editCommand(refused, [
					'no-provider',
					'--home',
					sb.home,
					'--kind',
					kind,
					'--prompt',
					'Check status',
					'--yes',
				]),
				kind,
			).toBe(64)
			expect(refused.out.errors.join(' '), kind).toMatch(/no provider is configured/)
		}
		const converted = recordingContext()
		expect(
			await editCommand(converted, [
				'no-provider',
				'--home',
				sb.home,
				'--kind',
				'script+agent',
				'--prompt',
				'Check status',
				'--model',
				'deepseek/deepseek-chat',
				'--yes',
			]),
		).toBe(0)
		expect(findJob(sb.paths, 'no-provider')).toMatchObject({
			runKind: 'script+agent',
			model: { provider: 'deepseek', model: 'deepseek-chat' },
		})
	})

	it('still requires a model for agent and script+agent jobs', async () => {
		for (const kind of ['agent', 'script+agent']) {
			const ctx = recordingContext()
			const code = await addCommand(ctx, [
				`needs-model-${kind.replace('+', '-')}`,
				'--home',
				sb.home,
				'--when',
				'every 1m',
				'--folder',
				sb.project,
				'--kind',
				kind,
				'--prompt',
				'Check status',
				...(kind === 'script+agent'
					? [
							'--script',
							'echo \'{"wake":false,"context":""}\'',
							'--shell',
							hostCommandShell().dialect,
						]
					: []),
				'--permissions',
				permissions(sb, {}),
				'--yes',
			])
			expect(code, kind).toBe(64)
			expect(ctx.out.errors.join(' '), kind).toMatch(/no provider is configured/)
		}
	})

	it('rejects an explicit model or effort on a pure script instead of silently dropping it', async () => {
		for (const extra of [
			['--model', 'deepseek/deepseek-chat'],
			['--effort', 'high'],
		]) {
			const ctx = recordingContext()
			const code = await addCommand(ctx, [
				'irrelevant-model',
				...base(sb),
				'--kind',
				'script',
				'--script',
				'echo hi',
				'--shell',
				hostCommandShell().dialect,
				'--permissions',
				permissions(sb, {}),
				...extra,
				'--yes',
			])
			expect(code, extra[0]).toBe(64)
			expect(ctx.out.errors.join(' '), extra[0]).toMatch(/has no model or effort/)
		}
	})

	it('rejects a prompt and agent-only flags on a pure script before creating it', async () => {
		const promptFile = join(sb.root, 'unused-prompt.txt')
		writeFileSync(promptFile, 'unused')
		for (const [flag, value] of [
			['--prompt', 'do something else'],
			['--prompt-file', promptFile],
			['--max-iterations', '5'],
			['--token-budget', '50000'],
			['--timeout', '2m'],
			['--wait-for-provider', '2m'],
			['--approval-ttl', '2d'],
			['--keep-sessions', '5'],
		]) {
			const ctx = recordingContext()
			expect(
				await addCommand(ctx, [
					'rejected',
					...base(sb),
					'--kind',
					'script',
					'--script',
					'echo hi',
					'--shell',
					hostCommandShell().dialect,
					'--permissions',
					permissions(sb, {}),
					flag,
					value,
					'--yes',
				]),
				flag,
			).toBe(64)
			expect(ctx.out.errors.join(' '), flag).toContain(flag)
			expect(ctx.out.info).toEqual([])
		}
		expect(() => findJob(sb.paths, 'rejected')).toThrow()
	})

	it('refuses a browser grant on a new pure script', async () => {
		const ctx = recordingContext()
		expect(
			await addCommand(ctx, [
				'browser-script',
				...base(sb),
				'--kind',
				'script',
				'--script',
				'echo hi',
				'--shell',
				hostCommandShell().dialect,
				'--permissions',
				permissions(sb, {}),
				'--browser',
				'main',
				'--browser-site',
				'https://example.com=read',
				'--yes',
			]),
		).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/pure script job cannot use a browser grant/)
	})

	it('creates a script job that needs no prompt, given --script and --shell', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'ticker',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo hi',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }),
			'--yes',
		])
		if (code !== 0) throw new Error(ctx.out.errors.join('\n'))
		expect(code).toBe(0)
		const job = findJob(sb.paths, 'ticker')
		expect(job.runKind).toBe('script')
		expect(job.script).toMatchObject({ body: 'echo hi', shell: 'bash' })
		expect(job.prompt).toBe('')
		expect(job.v).toBe(2)
	})

	it('reads the script from --script-file, and refuses both flags together', async () => {
		const file = join(sb.root, 'ping.sh')
		writeFileSync(file, 'echo pong\n')
		const ctx = recordingContext()
		expect(
			await addCommand(ctx, [
				'file-ticker',
				...base(sb),
				'--kind',
				'script',
				'--script-file',
				file,
				'--shell',
				'bash',
				'--permissions',
				permissions(sb, { bash: 'allow' }),
				'--yes',
			]),
		).toBe(0)
		expect(findJob(sb.paths, 'file-ticker').script?.body).toBe('echo pong\n')

		const both = recordingContext()
		expect(
			await addCommand(both, [
				'both',
				...base(sb),
				'--kind',
				'script',
				'--script',
				'echo hi',
				'--script-file',
				file,
				'--shell',
				'bash',
				'--permissions',
				permissions(sb, { bash: 'allow' }),
			]),
		).toBe(64)
		expect(both.out.errors.join(' ')).toMatch(/not both/)
	})

	it('requires --shell for a script job', async () => {
		const ctx = recordingContext()
		expect(
			await addCommand(ctx, [
				'noshell',
				...base(sb),
				'--kind',
				'script',
				'--script',
				'echo hi',
				'--permissions',
				permissions(sb, { bash: 'allow' }),
			]),
		).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/--shell/)
	})

	it('rejects --kind of anything but agent, script or script+agent', async () => {
		const ctx = recordingContext()
		expect(
			await addCommand(ctx, [
				'bad-kind',
				...base(sb),
				'--kind',
				'ruby',
				'--permissions',
				'read-only',
			]),
		).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/--kind is agent, script, script\+agent/)
	})
})

describe('a script the floor or the job rules refuse is held before any preview', () => {
	it('refuses a script the scheduled-run floor denies, naming the command, before printing anything', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'evil',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'systemctl --user stop namzu-scheduler',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }),
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.info).toEqual([])
		expect(ctx.out.errors.join(' ')).toMatch(/scheduled-run floor refused/)
		expect(() => findJob(sb.paths, 'evil')).toThrow()
	})

	it('refuses an opaque construct, naming the lexer’s reason', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'opaque',
			...base(sb),
			'--kind',
			'script',
			// `${ …; }` (bash 5.3's brace-form command substitution) is left
			// opaque; unlike `$(…)`/backtick, a plain command substitution,
			// which this now reads instead of refusing outright.
			'--script',
			'echo "${ date; }"',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }),
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.info).toEqual([])
		expect(ctx.out.errors.join(' ')).toMatch(/cannot be verified line-for-line/)
		expect(ctx.out.errors.join(' ')).toMatch(/command substitution/)
	})

	it('reads a clean command substitution instead of refusing the script outright', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'ticker',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo "$(date)"',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }),
			'--yes',
		])
		expect(code).toBe(0)
		expect(findJob(sb.paths, 'ticker').script?.body).toBe('echo "$(date)"')
	})

	it('refuses a script one of whose commands the job’s own rules deny, naming the command', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'partial',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo hi\ncurl http://evil.example/x',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: { 'curl*': 'deny' } }),
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.errors.join(' ')).toContain('curl')
	})

	it('needs no allow rule at all: an empty rule set is enough for a floor-clean script', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'no-rules-needed',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo hi',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, {}),
			'--yes',
		])
		if (code !== 0) throw new Error(ctx.out.errors.join('\n'))
		expect(code).toBe(0)
	})

	it('refuses unmatched: park for a pure script job', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			'parked',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo hi',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }, 'park'),
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(/unmatched: park/)
	})
})

describe('editing a script job', () => {
	it('keeps a real model field on a previously written script job', async () => {
		const original = await addCommand(recordingContext(), [
			'old-script',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo one',
			'--shell',
			hostCommandShell().dialect,
			'--permissions',
			permissions(sb, {}),
			'--yes',
		])
		expect(original).toBe(0)
		const pending = findJob(sb.paths, 'old-script')
		const legacy = updateJob(sb.paths, pending.id, pending.revision, (job) =>
			confirmJob(
				{ ...job, model: { provider: 'deepseek', model: 'deepseek-chat' } },
				'cli-tty',
				new Date(),
			),
		)
		expect(confirmationHolds(legacy)).toBe(true)
		expect(JSON.parse(readFileSync(sb.paths.job(legacy.id), 'utf8')).model).toEqual(legacy.model)
		expect(await runNowCommand(recordingContext(), ['old-script', '--home', sb.home])).toBe(0)
		const last = readState(sb.paths, legacy.id).lastRun
		expect(last?.status).toBe('completed')
		expect(
			readRunResult(sb.paths, legacy.id, last?.runId as string)?.scriptOutput?.stdout.trim(),
		).toBe('one')
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, ['old-script', '--home', sb.home, '--script', 'echo two', '--yes']),
		).toBe(0)
		expect(findJob(sb.paths, 'old-script').model).toEqual(legacy.model)
	})

	it('a plain edit keeps the runKind and script; a hand-edit is caught by the digest, not this path', async () => {
		await addCommand(recordingContext(), [
			'ticker',
			...base(sb),
			'--kind',
			'script',
			'--script',
			'echo one',
			'--shell',
			'bash',
			'--permissions',
			permissions(sb, { bash: 'allow' }),
			'--yes',
		])
		const ctx = recordingContext()
		const code = await editCommand(ctx, [
			'ticker',
			'--home',
			sb.home,
			'--script',
			'echo two',
			'--yes',
		])
		if (code !== 0) throw new Error(ctx.out.errors.join('\n'))
		const job = findJob(sb.paths, 'ticker')
		expect(job.runKind).toBe('script')
		expect(job.script?.body).toBe('echo two')
	})
})
