import type { ScheduleJobPreview } from '@namzu/sdk'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import {
	type ScheduleReviewAnswer,
	type ScheduleReviewRequest,
	ScheduleReviewOverlay,
	scheduleReviewSummary,
} from '../ScheduleReviewOverlay.js'
import { ViewportBound } from '../ViewportBound.js'

const preview: ScheduleJobPreview = {
	name: 'issue-notifier',
	folder: '/home/arda/namzu-issue-notifier',
	outsideSessionRoots: true,
	prompt: '',
	runKind: 'script',
	script: { body: 'echo hello', shell: 'bash', timeoutMs: 60_000 },
	schedule: 'every 5 minutes',
	nextFireTimes: [],
	rules: ['write: allow', 'bash: ask'],
	unmatched: 'deny',
	execution: 'host',
	networkAccess: true,
	budget: { maxIterations: 0, tokenBudget: 0, timeoutMs: 60_000 },
	warnings: ['This run can reach the network.'],
}

const source = Array.from({ length: 35 }, (_, index) => `script line ${index + 1}`).join('\n')
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const request: ScheduleReviewRequest = {
	action: 'create',
	preview,
	fullText: `Full host-computed proposal\n${source}\nlast exact line: echo done`,
}

describe('schedule review overlay', () => {
	it('opens on Cancel and keeps the real script consequences visible', () => {
		let answer: ScheduleReviewAnswer | undefined
		const screen = render(
			<ScheduleReviewOverlay request={request} columns={80} rows={24} onAnswer={(value) => { answer = value }} />,
		)
		const frame = screen.lastFrame() ?? ''
		expect(frame).toContain('proposed by the model')
		expect(frame).toContain('every 5 minutes')
		expect(frame).toContain('This run can reach the network.')
		expect(frame).toContain('folder is cwd, not a write boundary')
		expect(frame).toContain('Allow, ask and unmatched rules do not limit this script.')
		expect(frame).toContain('Folder is outside this session')
		expect(frame).toContain('Full proposal')
		expect(frame).not.toContain('last exact line: echo done')
		screen.stdin.write('\r')
		expect(answer).toBe('cancel')
		screen.unmount()
	})

	it('keeps the entire proposal reachable in a bounded scroll area', async () => {
		const screen = render(
			<ScheduleReviewOverlay request={request} columns={80} rows={24} onAnswer={() => {}} />,
		)
		const first = screen.lastFrame() ?? ''
		expect(first.split('\n').length).toBeLessThanOrEqual(24)
		expect(first).toContain('Scroll to the end to enable Create')
		screen.stdin.write('G')
		await flush()
		const last = screen.lastFrame() ?? ''
		expect(last).toContain('last exact line: echo done')
		expect(last).toContain('3 Create')
		screen.unmount()
	})

	it('shows changes and only saves after a deliberate choice', async () => {
		let answer: ScheduleReviewAnswer | undefined
		const update: ScheduleReviewRequest = {
			...request,
			action: 'update',
			permissionsChange: true,
			fullText: 'Changed since it was last confirmed\n- When every minute\n+ When every 5 minutes',
		}
		const screen = render(
			<ScheduleReviewOverlay request={update} columns={80} rows={24} onAnswer={(value) => { answer = value }} />,
		)
		expect(screen.lastFrame()).toContain('Permissions change from the next run.')
		screen.stdin.write('2')
		await flush()
		screen.stdin.write('\r')
		expect(answer).toBe('save')
		screen.unmount()
	})

	it('labels a saved job as Confirm and requires reviewing the whole source', async () => {
		let answer: ScheduleReviewAnswer | undefined
		const confirm: ScheduleReviewRequest = { ...request, action: 'confirm' }
		const screen = render(
			<ScheduleReviewOverlay request={confirm} columns={80} rows={24} onAnswer={(value) => { answer = value }} />,
		)
		const first = screen.lastFrame() ?? ''
		expect(first).toContain('review this saved job')
		expect(first).not.toContain('proposed by the model')
		expect(first).toContain('2 Confirm paused')
		expect(first).toContain('3 Confirm')
		screen.stdin.write('3')
		await flush()
		screen.stdin.write('\r')
		expect(answer).toBeUndefined()
		screen.stdin.write('G')
		await flush()
		screen.stdin.write('\r')
		expect(answer).toBe('create')
		screen.unmount()
	})

	it('describes a script gate separately from the agent permissions', () => {
		const lines = scheduleReviewSummary({
			...request,
			preview: { ...preview, runKind: 'script+agent' },
		})
		expect(lines.join('\n')).toContain('permission set governs its tools')
	})

	it('shows the private workspace, host authority and source conversation without the scratch path', () => {
		const lines = scheduleReviewSummary({
			...request,
			preview: {
				...preview,
				workspace: 'none',
				delivery: {
					kind: 'source-conversation',
					sessionId: 'session-123',
					projectSlug: 'project',
					projectId: 'project-id',
					tenantId: 'tenant-id',
				},
			},
		})
		const rendered = lines.join('\n')
		expect(rendered).toContain('Private scheduler workspace (no project)')
		expect(rendered).toContain('Source conversation session-123')
		expect(rendered).toContain('host process as your user')
		expect(rendered).not.toContain(preview.folder)
	})

	it('names the JSON report protocol before scrolling', () => {
		const lines = scheduleReviewSummary({
			...request,
			preview: {
				...preview,
				script: { body: 'echo hello', shell: 'bash', timeoutMs: 60_000, report: 'json-v1' },
			},
		})
		expect(lines.join('\n')).toContain('JSON v1: quiet/changed; optional scheduler state')
	})

	it('shows when generic success notices are disabled without hiding failure notices', () => {
		const lines = scheduleReviewSummary({
			...request,
			preview: { ...preview, notifyOnFinish: false },
		})
		expect(lines.join('\n')).toContain('Generic success notices off; failures still notify.')
	})

	it('identifies a manual add as requested by the operator', () => {
		const lines = scheduleReviewSummary({ ...request, proposedByModel: false })
		expect(lines[0]).toContain('requested by you')
		expect(lines[0]).not.toContain('proposed by the model')
	})

	it('does not apply a selected creation until the full proposal has been reached', async () => {
		let answer: ScheduleReviewAnswer | undefined
		const screen = render(
			<ScheduleReviewOverlay request={request} columns={80} rows={24} onAnswer={(value) => { answer = value }} />,
		)
		screen.stdin.write('3')
		await flush()
		screen.stdin.write('\r')
		expect(answer).toBeUndefined()
		screen.stdin.write('G')
		await flush()
		screen.stdin.write('\r')
		expect(answer).toBe('create')
		screen.unmount()
	})

	it('keeps warnings visible and stays within a short terminal', () => {
		const warned: ScheduleReviewRequest = {
			...request,
			promptFindings: ['A prompt tripwire finding.'],
			preview: {
				...preview,
				warnings: [
					...preview.warnings,
					'This run drives the browser signed in as you (profile work) on github.com.',
					'Chosen by the model, not the default: folder elsewhere',
				],
			},
		}
		const full = scheduleReviewSummary(warned).join('\n')
		expect(full).toContain('signed-in browser profile')
		expect(full).toContain('1 prompt finding')
		expect(full).toContain('1 other warning')
		const screen = render(
			<ScheduleReviewOverlay request={warned} columns={80} rows={14} onAnswer={() => {}} />,
		)
		const frame = screen.lastFrame() ?? ''
		expect(frame.split('\n').length).toBeLessThanOrEqual(14)
		expect(frame).toContain('3 warnings')
		expect(frame).toContain('Full proposal')
		screen.unmount()
	})

	it('fails closed when terminal rows cannot show review and actions together', () => {
		let answer: ScheduleReviewAnswer | undefined
		const screen = render(
			<ScheduleReviewOverlay request={request} columns={80} rows={12} onAnswer={(value) => { answer = value }} />,
		)
		expect(screen.lastFrame()).toContain('Resize the terminal')
		expect(screen.lastFrame()).not.toContain('3 Create')
		screen.stdin.write('\r')
		expect(answer).toBe('cancel')
		screen.unmount()
	})

	it('keeps its decision footer visible with the app status row at 24 rows', () => {
		const screen = render(
			<ViewportBound rows={24}>
				<Box flexDirection="column">
					<ScheduleReviewOverlay request={request} columns={78} rows={22} onAnswer={() => {}} />
					<Text>Status</Text>
				</Box>
			</ViewportBound>,
		)
		const frame = screen.lastFrame() ?? ''
		expect(frame.split('\n').length).toBeLessThanOrEqual(23)
		expect(frame).toContain('Cancel')
		expect(frame).toContain('Scroll to the end')
		expect(frame).toContain('Status')
		screen.unmount()
	})
})
