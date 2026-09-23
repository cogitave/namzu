/**
 * `schedule add --browser … --browser-site …` and `schedule edit` of a
 * browser grant, as a script meets them: the grant is stored canonical, the
 * preview says what the run may do on each site, and any change to the
 * grant is a new job to confirm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCommand, editCommand } from '../commands/add.js'
import { findJob } from '../store/jobs.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

const base = (sb: Sandbox) => [
	'post',
	'--home',
	sb.home,
	'--prompt',
	'Post good morning',
	'--when',
	'every 5m',
	'--folder',
	sb.project,
	'--model',
	'deepseek/deepseek-chat',
]

describe('schedule add --browser', () => {
	it('stores the grant canonical and shows it before anything is written', async () => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			...base(sb),
			'--permissions',
			'read-only',
			'--unmatched',
			'park',
			'--browser',
			'social',
			'--browser-site',
			'HTTP://Localhost:8123/=act',
			'--browser-site',
			'https://news.example=ask',
			'--yes',
		])
		expect(ctx.out.errors).toEqual([])
		expect(code).toBe(0)
		const job = findJob(sb.paths, 'post')
		expect(job.permissions.browser).toEqual({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act', 'https://news.example': 'ask' },
		})
		const preview = ctx.out.info.join('\n')
		expect(preview).toContain('Network     THIS RUN CAN REACH THE NETWORK')
		expect(preview).toContain(
			'Browser     SIGNED IN AS YOU: profile social, only http://localhost:8123, https://news.example',
		)
		expect(preview).toContain('browser: profile social, no window')
		expect(preview).toContain(
			'browser https://news.example: open and read; each change waits for you',
		)
		expect(preview).toContain('browser any other site: deny')
	})

	it('takes a browser grant alone, with --unmatched', async () => {
		const code = await addCommand(recordingContext(), [
			...base(sb),
			'--unmatched',
			'deny',
			'--browser',
			'social',
			'--browser-site',
			'https://news.example=read',
			'--browser-headed',
			'--yes',
		])
		expect(code).toBe(0)
		expect(findJob(sb.paths, 'post').permissions).toMatchObject({
			unmatched: 'deny',
			rules: {},
			browser: { profile: 'social', headed: true },
		})
	})

	it.each([
		[['--browser-site', 'https://a.example=read'], /need --browser <profile>/],
		[['--browser', 'social'], /at least one site/],
		[['--browser', 'social', '--browser-site', '*=read'], /every site/],
		[['--browser', 'social', '--browser-site', 'https://a.example'], /write <site>=read/],
		[
			['--browser', 'social', '--browser-site', 'https://a.example=ask', '--unmatched', 'deny'],
			/refused every time/,
		],
		[['--browser', 'Social Work', '--browser-site', 'https://a.example=read'], /profile name/],
	])('refuses %j (64)', async (flags, message) => {
		const ctx = recordingContext()
		const code = await addCommand(ctx, [
			...base(sb),
			'--permissions',
			'read-only',
			...flags,
			'--yes',
		])
		expect(code).toBe(64)
		expect(ctx.out.errors.join(' ')).toMatch(message)
	})
})

describe('schedule edit of a browser grant', () => {
	const granted = () =>
		confirmedJob(sb, {
			name: 'post',
			permissions: {
				preset: 'read-only',
				unmatched: 'park',
				browser: { profile: 'social', sites: { 'http://localhost:8123': 'act' } },
			},
		})

	it('adds a site and holds the job until someone confirms it again', async () => {
		const before = granted()
		expect(before.state).toBe('active')
		const ctx = recordingContext()
		const code = await editCommand(ctx, [
			'post',
			'--home',
			sb.home,
			'--browser-site',
			'https://news.example=read',
			'--yes',
		])
		expect(code).toBe(0)
		const after = findJob(sb.paths, 'post')
		expect(after.permissions.browser?.sites).toEqual({
			'http://localhost:8123': 'act',
			'https://news.example': 'read',
		})
		expect(after.state).toBe('pending-confirmation')
		expect(after.confirmation).toBeNull()
		expect(ctx.out.info.join('\n')).toContain(
			'browser https://news.example: open and read, never change',
		)
	})

	it('takes a site off with =none, and the whole grant with --no-browser', async () => {
		granted()
		await editCommand(recordingContext(), [
			'post',
			'--home',
			sb.home,
			'--browser-site',
			'https://news.example=read',
			'--yes',
		])
		await editCommand(recordingContext(), [
			'post',
			'--home',
			sb.home,
			'--browser-site',
			'http://localhost:8123=none',
			'--yes',
		])
		expect(findJob(sb.paths, 'post').permissions.browser?.sites).toEqual({
			'https://news.example': 'read',
		})
		await editCommand(recordingContext(), ['post', '--home', sb.home, '--no-browser', '--yes'])
		expect(findJob(sb.paths, 'post').permissions.browser).toBeUndefined()
	})

	it('keeps the grant when only the prompt changes', async () => {
		granted()
		await editCommand(recordingContext(), ['post', '--home', sb.home, '--prompt', 'Other', '--yes'])
		expect(findJob(sb.paths, 'post').permissions.browser?.profile).toBe('social')
	})
})
