import type { BackgroundJob, BackgroundJobOutput } from '@namzu/sdk'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it } from 'vitest'

import {
	BackgroundJobsPanel,
	backgroundJobOutputRows,
	maxBackgroundJobTailOffset,
} from '../BackgroundJobsPanel.js'
import { type Screen, renderToScreen } from './support/screen.js'

const STARTED = 1_000
const NOW = 31_000

function job(id: string, command: string, status: BackgroundJob['status'] = 'running'): BackgroundJob {
	return {
		id,
		owner: 'session',
		command,
		status,
		startedAt: STARTED,
		...(status === 'running' ? {} : { exitedAt: NOW }),
		...(status === 'exited' ? { exitCode: 0 } : {}),
	}
}

function output(chunk: string, droppedBytes = 0): BackgroundJobOutput {
	return {
		chunk,
		nextOffset: Buffer.byteLength(chunk),
		droppedBytes,
		status: 'running',
	}
}

let screen: Screen | null = null
afterEach(async () => {
	await screen?.unmount()
	screen = null
})

describe('the shell jobs child screen', () => {
	it('shows a persistent job as a selectable row at 40 columns without overflowing', async () => {
		const jobs = [job('job_1', 'npm run dev'), job('job_2', 'pnpm build', 'exited')]
		screen = await renderToScreen(
			<BackgroundJobsPanel
				jobs={jobs}
				selectedJobId="job_1"
				detailJobId={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={20}
				columns={40}
				now={NOW}
			/>,
			{ cols: 40, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Shell jobs · 1 running')
		expect(visible).toContain('> job_1 · running · npm run dev')
		expect(visible).toContain('job_2 · exited · pnpm build')
		expect(visible).toContain('x stop')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(40)
	})

	it('shows detail status and bounded terminal-safe output, then follows the latest rows', async () => {
		const jobs = [job('job_1', 'npm run dev\x1b[2J')]
		const readJob = () => output('ready\n\x1b[31munsafe\x1b[0m\nlast line\n', 12)
		screen = await renderToScreen(
			<BackgroundJobsPanel
				jobs={jobs}
				selectedJobId="job_1"
				detailJobId="job_1"
				tailOffset={0}
				readJob={readJob}
				rows={24}
				columns={80}
				now={NOW}
			/>,
			{ cols: 80, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Shell details · job_1')
		expect(visible).toContain('running · 30s')
		expect(visible).toContain('npm run dev\\u{001b}[2J')
		expect(visible).toContain('Earlier output discarded by the job buffer')
		expect(visible).toContain('\\u{001b}[31munsafe')
		expect(visible).toContain('last line')
		expect(visible).toContain('x stop')
		expect(screen.bufferType()).toBe('normal')
	})

	it('keeps the narrow detail panel on screen and drops stop when the job has ended', async () => {
		const jobs = [job('job_1', 'npm run dev', 'exited')]
		screen = await renderToScreen(
			<BackgroundJobsPanel
				jobs={jobs}
				selectedJobId="job_1"
				detailJobId="job_1"
				tailOffset={0}
				readJob={() => output('Server ready\n')}
				rows={20}
				columns={40}
				now={NOW}
			/>,
			{ cols: 40, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('exited 0 · 30s')
		expect(visible).toContain('Server ready')
		expect(visible).toContain('esc jobs')
		expect(visible).not.toContain('x stop')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(40)
	})

	it('keeps the exit key visible in the list and detail at 28 and 40 columns', async () => {
		const jobs = [job('job_1', 'npm run dev')]
		for (const columns of [28, 40]) {
			const base = {
				jobs,
				selectedJobId: 'job_1',
				tailOffset: 0,
				readJob: () => output('ready\n'),
				rows: 20,
				columns: columns - 2, // App's one-cell padding on each side.
				now: NOW,
			}
			screen = await renderToScreen(
				<BackgroundJobsPanel {...base} detailJobId={null} />,
				{ cols: columns, rows: 20 },
			)
			expect(screen.viewport().join('\n')).toContain('esc')
			await screen.unmount()
			screen = await renderToScreen(
				<BackgroundJobsPanel {...base} detailJobId="job_1" />,
				{ cols: columns, rows: 20 },
			)
			const detail = screen.viewport().join('\n')
			expect(detail).toContain('x stop · esc jobs')
			expect(detail).not.toContain('esc jo…')
			for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(columns)
			await screen.unmount()
			screen = null
		}
	})

	it('bounds a noisy process to its latest output and reports both kinds of omission', () => {
		const long = `HEAD${'old'.repeat(12_000)}\nTAIL`
		const rows = backgroundJobOutputRows(output(long, 100), 40)
		expect(rows.join('')).toContain('Earlier output discarded by the job buffer (100 bytes).')
		expect(rows.join('')).toContain('Showing the latest 32768 bytes.')
		expect(rows.join('\n')).toContain('TAIL')
		expect(rows.join('\n')).not.toContain('HEAD')
		expect(maxBackgroundJobTailOffset(output('one\ntwo\nthree\nfour\nfive'), 20, 40)).toBe(1)
	})
})
