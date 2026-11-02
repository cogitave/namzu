import type { BackgroundJob, BackgroundJobOutput } from '@namzu/sdk'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it } from 'vitest'

import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../../integrations/subagents/activity.js'
import {
	BackgroundJobsPanel,
	backgroundJobOutputRows,
	maxBackgroundJobTailOffset,
} from '../BackgroundJobsPanel.js'
import { backgroundRows, jobKey } from '../background-view.js'
import { type Screen, renderToScreen } from './support/screen.js'

const STARTED = 1_000
const NOW = 31_000

function job(
	id: string,
	command: string,
	status: BackgroundJob['status'] = 'running',
): BackgroundJob {
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

describe('a monitor in the Background dialog', () => {
	const monitor: BackgroundJob = {
		...job('b00000003', 'tail -f deploy.log'),
		kind: 'monitor',
		description: 'errors in deploy log',
	}

	it('is listed by what it watches, counted apart from shells, with a stop', async () => {
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows([monitor, job('b00000001', 'npm run dev')], [])}
				selectedKey={jobKey('b00000003')}
				detailKey={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={20}
				columns={60}
				now={NOW}
			/>,
			{ cols: 60, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('1 active shell')
		expect(visible).toContain('errors in deploy log  running')
		expect(visible).toContain('x stop')
		expect(visible).not.toContain('tail -f')
		expect(visible).not.toContain('b0000000')
	})

	it('shows what it watches and how it ended in its details', async () => {
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows(
					[{ ...monitor, status: 'killed', exitedAt: NOW, stopReason: 'expired' }],
					[],
				)}
				selectedKey={jobKey('b00000003')}
				detailKey={jobKey('b00000003')}
				tailOffset={0}
				readJob={() => output('line\n')}
				rows={24}
				columns={80}
				now={NOW}
			/>,
			{ cols: 80, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Monitor details')
		expect(visible).toContain('Watching: errors in deploy log')
		expect(visible).toContain('ran out of time')
	})
})

describe('the Background dialog shell rows', () => {
	it('shows a persistent job as a selectable row at 40 columns without overflowing', async () => {
		const jobs = [job('b00000001', 'npm run dev'), job('b00000002', 'pnpm build', 'exited')]
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows(jobs, [])}
				selectedKey={jobKey('b00000001')}
				detailKey={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={20}
				columns={40}
				now={NOW}
			/>,
			{ cols: 40, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Background')
		expect(visible).toContain('1 active shell')
		expect(visible).toContain('❯ ● npm run dev  running')
		expect(visible).toContain('● pnpm build  done')
		expect(visible).not.toContain('b0000000')
		expect(visible).toContain('x stop')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(40)
	})

	it('shows detail status and bounded terminal-safe output, then follows the latest rows', async () => {
		const jobs = [job('b00000001', 'npm run dev\x1b[2J')]
		const readJob = () => output('ready\n\x1b[31munsafe\x1b[0m\nlast line\n', 12)
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows(jobs, [])}
				selectedKey={jobKey('b00000001')}
				detailKey={jobKey('b00000001')}
				tailOffset={0}
				readJob={readJob}
				rows={24}
				columns={80}
				now={NOW}
			/>,
			{ cols: 80, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Shell details')
		expect(visible).not.toContain('b0000000')
		expect(visible).toContain('Status: running')
		expect(visible).toContain('Runtime: 30s')
		expect(visible).toContain('Command:')
		expect(visible).toContain('Output:')
		expect(visible).toContain('npm run dev\\u{001b}[2J')
		expect(visible).toContain('Earlier output was dropped')
		expect(visible).toContain('\\u{001b}[31munsafe')
		expect(visible).toContain('last line')
		expect(visible).toContain('x stop')
		expect(screen.bufferType()).toBe('normal')
	})

	it('keeps the narrow detail panel on screen and drops stop when the job has ended', async () => {
		const jobs = [job('b00000001', 'npm run dev', 'exited')]
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows(jobs, [])}
				selectedKey={jobKey('b00000001')}
				detailKey={jobKey('b00000001')}
				tailOffset={0}
				readJob={() => output('Server ready\n')}
				rows={20}
				columns={40}
				now={NOW}
			/>,
			{ cols: 40, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Status: done (exit code: 0)')
		expect(visible).toContain('Runtime: 30s')
		expect(visible).toContain('Server ready')
		expect(visible).toContain('← back')
		expect(visible).not.toContain('x stop')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(40)
	})

	it('keeps the exit key visible in the list and detail at 28 and 40 columns', async () => {
		const jobs = [job('b00000001', 'npm run dev')]
		for (const columns of [28, 40]) {
			const base = {
				entries: backgroundRows(jobs, []),
				selectedKey: jobKey('b00000001'),
				tailOffset: 0,
				readJob: () => output('ready\n'),
				rows: 20,
				columns: columns - 2, // App's one-cell padding on each side.
				now: NOW,
			}
			screen = await renderToScreen(<BackgroundJobsPanel {...base} detailKey={null} />, {
				cols: columns,
				rows: 20,
			})
			expect(screen.viewport().join('\n')).toContain('esc')
			await screen.unmount()
			screen = await renderToScreen(
				<BackgroundJobsPanel {...base} detailKey={jobKey('b00000001')} />,
				{ cols: columns, rows: 20 },
			)
			const detail = screen.viewport().join('\n')
			expect(detail).toContain('x stop · ← back')
			expect(detail).not.toContain('← ba…')
			for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(columns)
			await screen.unmount()
			screen = null
		}
	})

	it('does not offer stop for a second job while a stop request is in flight', async () => {
		const jobs = [job('b00000001', 'npm run dev'), job('b00000002', 'pnpm build')]
		const base = {
			entries: backgroundRows(jobs, []),
			selectedKey: jobKey('b00000002'),
			tailOffset: 0,
			readJob: () => output('ready\n'),
			rows: 24,
			columns: 80,
			now: NOW,
			busyJobId: 'b00000001',
		}
		screen = await renderToScreen(<BackgroundJobsPanel {...base} detailKey={null} />, {
			cols: 80,
			rows: 24,
		})
		expect(screen.viewport().join('\n')).not.toContain('x stop')
		await screen.unmount()
		screen = await renderToScreen(
			<BackgroundJobsPanel {...base} detailKey={jobKey('b00000002')} />,
			{ cols: 80, rows: 24 },
		)
		expect(screen.viewport().join('\n')).not.toContain('x stop')
	})

	it('bounds a noisy process to its latest output and reports both kinds of omission', () => {
		const long = `HEAD${'old'.repeat(12_000)}\nTAIL`
		const rows = backgroundJobOutputRows(output(long, 100), 40)
		expect(rows.join('')).toContain('Earlier output was dropped (100 B).')
		expect(rows.join('')).toContain('Showing the latest 32 KB.')
		expect(rows.join('\n')).toContain('TAIL')
		expect(rows.join('\n')).not.toContain('HEAD')
		expect(maxBackgroundJobTailOffset(output('one\ntwo\nthree\nfour\nfive'), 20, 40)).toBe(1)
	})
})

describe('subagents in the Background dialog', () => {
	function agent(
		viewId: string,
		description: string,
		status: SubagentActivity['status'],
		startedAt: number,
	): SubagentActivity {
		return {
			viewId,
			agentId: 'worker',
			description,
			status,
			startedAt,
			workflow: DEFAULT_AGENT_WORKFLOW,
			phaseId: 'phase',
		} as unknown as SubagentActivity
	}

	it('groups commands, running agents and finished agents under their own headings', async () => {
		const entries = backgroundRows(
			[job('b00000001', 'npm run dev')],
			[
				agent('a1', 'review the diff', 'working', 2_000),
				agent('a2', 'write the tests', 'completed', 1_500),
				agent('a3', 'check types', 'failed', 1_600),
			],
		)
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={entries}
				selectedKey="agent:a1"
				detailKey={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={30}
				columns={78}
				now={NOW}
			/>,
			{ cols: 80, rows: 30 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('1 active shell · 1 active agent')
		expect(visible.indexOf('Shells (1)')).toBeLessThan(visible.indexOf('Local agents (1)'))
		expect(visible.indexOf('Local agents (1)')).toBeLessThan(visible.indexOf('Completed (2)'))
		expect(visible).toContain('❯ ● review the diff  running')
		expect(visible).toContain('● write the tests  done')
		expect(visible).toContain('● check types  failed')
		expect(visible).toContain('x stop')
	})

	it('draws no heading when only one section has rows', async () => {
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={backgroundRows([], [agent('a1', 'review the diff', 'working', 2_000)])}
				selectedKey="agent:a1"
				detailKey={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={30}
				columns={78}
				now={NOW}
			/>,
			{ cols: 80, rows: 30 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('1 active agent')
		expect(visible).not.toContain('Local agents')
	})

	it('says nothing is running when the list is empty', async () => {
		screen = await renderToScreen(
			<BackgroundJobsPanel
				entries={[]}
				selectedKey={null}
				detailKey={null}
				tailOffset={0}
				readJob={() => undefined}
				rows={30}
				columns={78}
				now={NOW}
			/>,
			{ cols: 80, rows: 30 },
		)
		expect(screen.viewport().join('\n')).toContain('No tasks currently running')
	})
})
