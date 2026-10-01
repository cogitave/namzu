import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildJob, confirmJob, editedJob, previewLines } from '../build.js'
import { addCommand, editCommand } from '../commands/add.js'
import { listCommand, showCommand } from '../commands/list.js'
import { checkScratchFolder, plannedScratchFolder } from '../folder.js'
import { compileJobPolicy } from '../policy.js'
import { ScheduleFormatError, readVersioned } from '../store/atomic.js'
import { appendHistory, readHistory } from '../store/history.js'
import { confirmationHolds, createJob, findJob, jobSecurityDigest } from '../store/jobs.js'
import { readState, writeState } from '../store/state.js'
import { runResultVersion } from '../types.js'
import { type Sandbox, jobRequest, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const source = {
	kind: 'source-conversation',
	sessionId: 'session-1',
	projectSlug: 'project-one',
	projectId: 'project-1',
	tenantId: 'tenant-1',
} as const

function build(over: Partial<ReturnType<typeof jobRequest>> = {}) {
	return buildJob(
		jobRequest(sb, {
			runKind: 'script',
			workspace: 'none',
			folder: undefined,
			script: { body: 'echo done', shell: 'sh' as const },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
			...over,
		}),
		{ paths: sb.paths, config: {}, now: new Date('2026-09-30T12:00:00Z'), osHome: sb.osHome },
	)
}

describe('no-project pure script workspace', () => {
	it('plans a job-id-keyed sibling outside NAMZU_HOME without creating it during preview', () => {
		const job = build({ delivery: source })
		const scratch = plannedScratchFolder(sb.home, job.id)
		expect(job.workspace).toBe('none')
		expect(job.folder).toEqual({ path: scratch, canonical: scratch })
		expect(dirname(dirname(scratch))).toBe(dirname(sb.home))
		expect(existsSync(scratch)).toBe(false)
		const policy = compileJobPolicy(job.permissions, {
			layers: [],
			namzuHome: sb.home,
			folder: job.folder,
		})
		const preview = previewLines(job, policy, new Date('2026-09-30T12:00:00Z')).join('\n')
		expect(preview).toContain('Workspace   none (private scratch directory for this job)')
		expect(preview).toContain('Results     post back to the source conversation')
		expect(preview).not.toContain(scratch)
		expect(existsSync(scratch)).toBe(false)
	})

	it('creates only on operator confirmation and requires private real directories', () => {
		const pending = build()
		const scratch = pending.folder.path
		confirmJob(pending, 'cli-noninteractive', new Date(), { paths: sb.paths })
		expect(existsSync(scratch)).toBe(false)
		const confirmed = confirmJob(pending, 'cli-tty', new Date(), { paths: sb.paths })
		expect(confirmationHolds(confirmed)).toBe(true)
		expect(checkScratchFolder(sb.home, pending.id)).toEqual({ ok: true, canonical: scratch })
		for (const dir of [dirname(scratch), scratch]) {
			expect(lstatSync(dir).mode & 0o777).toBe(0o700)
		}
		chmodSync(scratch, 0o755)
		expect(checkScratchFolder(sb.home, pending.id)).toMatchObject({ ok: false })
		expect(() => confirmJob(pending, 'cli-tty', new Date(), { paths: sb.paths })).toThrow(
			/mode 0700/,
		)
	})

	it('refuses a substituted scratch path or a symlink at the planned path', () => {
		const job = build()
		expect(() =>
			confirmJob(
				{ ...job, folder: { path: sb.project, canonical: sb.project } },
				'cli-tty',
				new Date(),
				{ paths: sb.paths },
			),
		).toThrow(/differs from the job id/)
		mkdirSync(dirname(job.folder.path), { mode: 0o700 })
		symlinkSync(sb.project, job.folder.path)
		expect(() => confirmJob(job, 'cli-tty', new Date(), { paths: sb.paths })).toThrow(
			/not a real directory/,
		)
	})

	it('binds workspace and delivery in the digest only when present', () => {
		const project = buildJob(jobRequest(sb), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})
		expect(jobSecurityDigest(project)).toBe(
			jobSecurityDigest({ ...project, workspace: undefined, delivery: undefined }),
		)
		const job = confirmJob(build({ delivery: source }), 'cli-tty', new Date(), {
			paths: sb.paths,
		})
		expect(confirmationHolds(job)).toBe(true)
		expect(confirmationHolds({ ...job, delivery: undefined })).toBe(false)
		expect(confirmationHolds({ ...job, workspace: undefined })).toBe(false)
	})

	it('allows only pure scripts and preserves the same scratch path on edit', () => {
		expect(() => build({ runKind: 'script+agent' })).toThrow(/only applies to a pure script/)
		expect(() => build({ folder: sb.project })).toThrow(/cannot be combined/)
		const current = build()
		const rebuilt = build({ when: '0 4 * * *' })
		const edited = editedJob(current, rebuilt)
		expect(edited.id).toBe(current.id)
		expect(edited.folder).toEqual(current.folder)
		expect(edited.workspace).toBe('none')
		const confirmed = confirmJob(edited, 'cli-tty', new Date(), { paths: sb.paths })
		expect(confirmationHolds(confirmed)).toBe(true)
	})

	it('refuses a script timeout that would overflow Node timers', () => {
		expect(() =>
			build({
				script: {
					body: 'echo done',
					shell: 'sh' as const,
					timeoutMs: 2_147_483_647,
				},
			}),
		).toThrow(/timer limit/)
	})

	it('writes v3 for new ownership fields or an opt-in JSON report', () => {
		const plain = build()
		const sourceBoundAgent = buildJob(jobRequest(sb, { delivery: source }), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})
		const legacyAgent = buildJob(jobRequest(sb), {
			paths: sb.paths,
			config: {},
			now: new Date(),
			osHome: sb.osHome,
		})
		const reported = build({
			script: { body: 'echo done', shell: 'sh' as const, report: 'json-v1' },
		})
		expect(plain.v).toBe(3)
		expect(sourceBoundAgent.v).toBe(3)
		expect(legacyAgent.v).toBe(1)
		expect(reported.v).toBe(3)
		if (!reported.script) throw new Error('report-enabled job has no script')
		expect(jobSecurityDigest(reported)).not.toBe(
			jobSecurityDigest({ ...reported, script: { ...reported.script, report: undefined } }),
		)
		expect(runResultVersion({ status: 'completed', scriptOutput: {} })).toBe(2)
		expect(runResultVersion({ status: 'completed', scriptReport: { v: 1 } })).toBe(3)
		createJob(sb.paths, reported)
		expect(() => readVersioned(sb.paths.job(reported.id), 'schedule-job', 2)).toThrow(
			ScheduleFormatError,
		)
		appendHistory(sb.paths, reported.id, {
			v: 3,
			kind: 'run',
			at: '2026-09-30T12:00:00Z',
			runId: 'run-1',
			key: '1',
			trigger: 'scheduled',
			startedAt: '2026-09-30T12:00:00Z',
			status: 'completed',
		})
		expect(readHistory(sb.paths, reported.id)).toHaveLength(1)
		expect(() =>
			build({
				runKind: 'script+agent',
				script: { body: 'echo done', shell: 'sh' as const, report: 'json-v1' },
			}),
		).toThrow(/pure script/)
	})

	it('accepts the CLI flag without a project folder and leaves an inert job without scratch', async () => {
		const ctx = recordingContext()
		const permissionFile = join(sb.root, 'permissions.json')
		writeFileSync(permissionFile, JSON.stringify({ rules: { bash: 'allow' }, unmatched: 'deny' }))
		expect(
			await addCommand(ctx, [
				'quick-check',
				'--home',
				sb.home,
				'--when',
				'every 1m',
				'--kind',
				'script',
				'--workspace',
				'none',
				'--script',
				'echo done',
				'--shell',
				'sh' as const,
				'--script-report',
				'json-v1',
				'--permissions',
				permissionFile,
				'--yes',
			]),
		).toBe(0)
		const job = findJob(sb.paths, 'quick-check')
		expect(job.workspace).toBe('none')
		expect(job.v).toBe(3)
		expect(job.script?.report).toBe('json-v1')
		expect(job.state).toBe('pending-confirmation')
		expect(existsSync(job.folder.path)).toBe(false)
		expect(ctx.out.info.join('\n')).not.toContain(job.folder.path)
		for (const [command, argv] of [
			[listCommand, ['--home', sb.home]],
			[showCommand, ['quick-check', '--home', sb.home]],
		] as const) {
			const view = recordingContext()
			expect(await command(view, argv)).toBe(0)
			const shown = String(view.out.printed[0])
			expect(shown).toContain('none (private scratch directory')
			expect(shown).not.toContain(job.folder.path)
			if (command === showCommand) expect(shown).toContain('Report      json-v1')
		}
	})

	it('reviews pending findings before a source binding can be removed', async () => {
		const job = createJob(
			sb.paths,
			confirmJob(build({ delivery: source }), 'cli-tty', new Date(), { paths: sb.paths }),
		)
		const runId = crypto.randomUUID()
		writeState(sb.paths, {
			...readState(sb.paths, job.id),
			deliveryPending: [
				{
					delivery: source,
					result: {
						v: 3,
						kind: 'schedule-run-result',
						jobId: job.id,
						runId,
						status: 'completed',
						exitCode: 0,
						startedAt: '2026-09-30T08:00:00.000Z',
						endedAt: '2026-09-30T08:00:01.000Z',
						scriptReport: { v: 1, state: 'changed', summary: 'Three new issues' },
					},
				},
			],
		})
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, [job.name, '--home', sb.home, '--delivery', 'none', '--yes']),
		).toBe(0)
		const edited = findJob(sb.paths, job.name)
		expect(edited.delivery).toBeUndefined()
		expect(edited.deliveryWaiverRunIds).toEqual([runId])
		expect(edited.state).toBe('pending-confirmation')
		expect(ctx.out.info.join('\n')).toContain('Three new issues')
		expect(ctx.out.info.join('\n')).toContain('will not appear in the old source conversation')
		expect(readState(sb.paths, job.id).deliveryPending).toHaveLength(1)
	})

	it('refuses to detach while a bound run may still produce an unseen result', async () => {
		const job = createJob(
			sb.paths,
			confirmJob(build({ delivery: source }), 'cli-tty', new Date(), { paths: sb.paths }),
		)
		writeState(sb.paths, {
			...readState(sb.paths, job.id),
			activeRun: {
				runId: crypto.randomUUID(),
				key: 'manual-test',
				trigger: 'manual',
				startedAt: '2026-09-30T08:00:00.000Z',
				daemonEpoch: 'test',
				status: 'running',
				delivery: source,
			},
		})
		const ctx = recordingContext()
		expect(
			await editCommand(ctx, [job.name, '--home', sb.home, '--delivery', 'none', '--yes']),
		).toBe(64)
		expect(ctx.out.errors.join('\n')).toMatch(/wait for the source-bound run/)
		expect(findJob(sb.paths, job.name).delivery).toEqual(source)
	})
})
