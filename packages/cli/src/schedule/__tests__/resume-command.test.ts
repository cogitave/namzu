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
