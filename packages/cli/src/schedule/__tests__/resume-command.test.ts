/**
 * Every place that tells the operator how to answer a park names the job's
 * folder: conversations are stored per folder, and `namzu resume <id>` from
 * anywhere else only says "not found".
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listCommand, listing, showCommand } from '../commands/list.js'
import { NOTICE_BODY_MAX, noticeText } from '../daemon/notify.js'
import { CallTally, callsCount, callsLine } from '../fire/calls.js'
import { resumeCommand, scheduledSessionElsewhere, shellQuote } from '../resume-command.js'
import { readState, writeState } from '../store/state.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

const SESSION = '01a0ce39-e0b5-70aa-af7d-b0c4f68ec3c0'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

function parked(folder = sb.project, addDir?: string) {
	const job = confirmedJob(sb, {
		folder,
		...(addDir ? { permissions: { preset: 'read-only', additionalDirectories: [addDir] } } : {}),
	})
	writeState(sb.paths, {
		...readState(sb.paths, job.id),
		activeRun: {
			runId: 'run-1',
			key: 'k',
			trigger: 'manual',
			startedAt: new Date().toISOString(),
			daemonEpoch: 'e',
			status: 'awaiting-approval',
			sessionId: SESSION,
		},
	})
	return job
}

describe('the command that answers a park', () => {
	it('quotes for a POSIX shell', () => {
		expect(shellQuote('/home/me/work')).toBe('/home/me/work')
		expect(shellQuote("/home/me/it's here")).toBe(`'/home/me/it'\\''s here'`)
		expect(shellQuote('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`)
	})

	it('carries the folder and the job’s extra roots', () => {
		const folder = join(sb.osHome, "odd dir's")
		const extra = join(sb.osHome, 'extra')
		mkdirSync(folder, { recursive: true })
		mkdirSync(extra, { recursive: true })
		const job = parked(folder, extra)
		expect(resumeCommand(job, SESSION)).toBe(
			`cd ${shellQuote(job.folder.canonical)} && namzu --add-dir ${extra} resume ${SESSION}`,
		)
		expect(resumeCommand(job, SESSION)).toContain(`'\\''s'`)
	})

	it('is in schedule list, list --json and show', async () => {
		const job = parked()
		const command = resumeCommand(job, SESSION)
		expect(listing(job, readState(sb.paths, job.id)).activeRun?.resumeCommand).toBe(command)
		const ctx = recordingContext()
		await listCommand(ctx, ['--home', sb.home])
		expect(String(ctx.out.printed[0])).toContain(`answer it: ${command}`)
		const show = recordingContext()
		await showCommand(show, [job.name, '--home', sb.home])
		expect(String(show.out.printed[0])).toContain(`answer it: ${command}`)
	})

	it('is in the notification when it fits whole, and never cut in half', () => {
		const job = parked()
		const command = resumeCommand(job, SESSION)
		const at = new Date('2026-09-23T03:00:00Z')
		expect(noticeText('awaiting-approval', job, { at, resumeCommand: command }).body).toContain(
			`answer it: ${command}`,
		)
		const long = `cd /${'x'.repeat(200)} && namzu resume ${SESSION}`
		const body = noticeText('awaiting-approval', job, { at, resumeCommand: long }).body
		expect(body).not.toContain('cd /')
		expect(body).toContain(`namzu schedule show ${job.name}`)
	})

	it('says what a tool needs from the person, and still fits whole', () => {
		const job = parked()
		const command = resumeCommand(job, SESSION)
		const at = new Date('2026-09-23T03:00:00Z')
		const handoff = 'Sign in to example.test'
		const body = noticeText('awaiting-approval', job, { at, resumeCommand: command, handoff }).body
		expect(body).toContain('needs you')
		expect(body).toContain(handoff)
		expect(body).not.toContain('approval')
		const long = 'x'.repeat(400)
		const cut = noticeText('awaiting-approval', job, { at, resumeCommand: command, handoff: long })
		expect([...cut.body].length).toBeLessThanOrEqual(NOTICE_BODY_MAX)
		expect(cut.body).toContain('needs you')
	})
})

describe('namzu resume <id> from another folder', () => {
	it('finds the job whose run owns the session, and the folder it lives in', () => {
		const job = parked()
		const found = scheduledSessionElsewhere(sb.home, SESSION, sb.osHome)
		expect(found?.job.id).toBe(job.id)
		expect(found?.command).toBe(resumeCommand(job, SESSION))
	})

	it('says nothing from the job’s own folder, or for another id', () => {
		parked()
		expect(scheduledSessionElsewhere(sb.home, SESSION, sb.project)).toBeUndefined()
		expect(scheduledSessionElsewhere(sb.home, 'another', sb.osHome)).toBeUndefined()
		expect(scheduledSessionElsewhere(join(sb.root, 'nowhere'), SESSION, sb.osHome)).toBeUndefined()
	})
})

describe('a completed run with refused calls', () => {
	const at = new Date('2026-09-24T08:03:15Z')
	const refused = {
		count: 1,
		first: {
			tool: 'bash',
			reason:
				'the scheduled-run floor refused this call: `powershell.exe` runs commands the floor does not read, and it holds `schedule stop`',
		},
	}
	const job = (includeSummary: boolean) => ({
		name: 'windows-alert-test',
		notify: { finished: true, failed: true, awaitingApproval: true, includeSummary },
	})

	it('is not told as a plain finish', () => {
		expect(noticeText('finished', job(false), { at }).body).toMatch(/^finished at /)
		const body = noticeText('finished', job(false), { at, refused, summary: 'x' }).body
		expect(body).toMatch(
			/^done at .+, but 1 call was refused \(bash\); namzu schedule show windows-alert-test says why$/,
		)
		// The reason quotes what the model wrote: not on a lock screen by default.
		expect(body).not.toContain('powershell')
	})

	it('gives the reason where the job asked for its summary, cut to fit', () => {
		const body = noticeText('finished', job(true), { at, refused, summary: 'x' }).body
		expect(body).toMatch(
			/^done at .+, but 1 call was refused: the scheduled-run floor refused this call: /,
		)
		const long = { ...refused, count: 3, first: { ...refused.first, reason: 'r'.repeat(400) } }
		const cut = noticeText('finished', job(true), { at, refused: long, summary: ' — done' }).body
		expect([...cut].length).toBeLessThanOrEqual(NOTICE_BODY_MAX)
		expect(cut).toMatch(/^done at .+, but 3 calls were refused: r+…/)
	})

	it('reads the kernel’s refusals and failures apart, in words', () => {
		const tally = new CallTally(['write'])
		tally.observe({ toolName: 'read', isError: false, summary: 'ok' })
		tally.observe({
			toolName: 'bash',
			isError: true,
			summary: '',
			output:
				'Error: Tool "bash" was not executed. Blocked by the authorization gate: the scheduled-run floor refused this call: x',
		})
		tally.observe({
			toolName: 'write',
			isError: true,
			summary: 'Error: Unknown or unavailable tool "write": Not found',
		})
		tally.observe({ toolName: 'read', isError: true, summary: 'Error: read failed: ENOENT\nstack' })
		tally.observe({ toolName: 'schedule', isError: true, summary: 'Cancelled', cancelled: true })
		const tallies = tally.tallies()
		expect(tallies).toEqual({
			refusedCalls: {
				count: 2,
				first: { tool: 'bash', reason: 'the scheduled-run floor refused this call: x' },
			},
			failedCalls: { count: 1, first: { tool: 'read', reason: 'read failed: ENOENT' } },
		})
		expect(callsLine(tallies)).toBe(
			'2 calls were refused (bash: the scheduled-run floor refused this call: x); 1 call failed (read: read failed: ENOENT)',
		)
		expect(callsCount({ refusedCalls: 1 })).toBe('1 call refused')
		expect(callsCount({ refusedCalls: 2, failedCalls: 1 })).toBe('2 calls refused, 1 failed')
		expect(callsCount({})).toBe('')
	})

	it('reads the kernel’s unknown-tool answer that lists what the step can call', () => {
		// The kernel answers a name its registry does not hold with the tools
		// the step can call (`unknownToolMessage` in the SDK's tool-call
		// admission), not the registry's "Not found". A withheld tool is such
		// a name, and its call is still a refusal; any other unknown name is
		// the model's mistake, a failure.
		const tally = new CallTally(['write'])
		tally.observe({
			toolName: 'write',
			isError: true,
			summary: '',
			output: 'Error: Unknown tool "write". Available: read, grep',
		})
		tally.observe({
			toolName: 'writ',
			isError: true,
			summary: '',
			output: 'Error: Unknown tool "writ". Available: read, grep',
		})
		expect(tally.tallies()).toEqual({
			refusedCalls: {
				count: 1,
				first: {
					tool: 'write',
					reason: "the job's permissions never let a run use write, so the run was not given it",
				},
			},
			failedCalls: {
				count: 1,
				first: { tool: 'writ', reason: 'Unknown tool "writ". Available: read, grep' },
			},
		})
	})
})
