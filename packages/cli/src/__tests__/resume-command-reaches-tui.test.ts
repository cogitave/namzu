/** The clean-exit handoff must be an actual interactive CLI address. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirmedJob, sandbox } from '../schedule/__tests__/fixtures.js'
import { readState, writeState } from '../schedule/store/state.js'

import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))

vi.mock('../tui/index.js', () => ({ launchTui }))

const { runCli } = await import('../cli.js')

describe('namzu resume <conversation-id>', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

	afterEach(() => {
		launchTui.mockClear()
		vi.restoreAllMocks()
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
	})

	it('launches the TUI with the exact durable id', async () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: true,
		})

		await expect(
			runCli({ argv: ['node', 'namzu', 'resume', '4aba553c-4222-48f2-8047-62a22f1f21d7'] }),
		).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		expect(launchTui).toHaveBeenCalledWith(
			expect.objectContaining({
				initialConversationId: '4aba553c-4222-48f2-8047-62a22f1f21d7',
			}),
		)
	})

	it('names the folder of a scheduled run resumed from elsewhere, instead of "not found"', async () => {
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
		const sb = sandbox()
		const previous = process.env.NAMZU_HOME
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		try {
			process.env.NAMZU_HOME = sb.home
			const job = confirmedJob(sb)
			const session = '01a0ce39-e0b5-70aa-af7d-b0c4f68ec3c0'
			writeState(sb.paths, {
				...readState(sb.paths, job.id),
				activeRun: {
					runId: 'run-1',
					key: 'k',
					trigger: 'manual',
					startedAt: new Date().toISOString(),
					daemonEpoch: 'e',
					status: 'awaiting-approval',
					sessionId: session,
				},
			})
			// This process's folder is not the job's.
			await expect(runCli({ argv: ['node', 'namzu', 'resume', session] })).resolves.toBe(64)
			expect(launchTui).not.toHaveBeenCalled()
			const said = stderr.mock.calls.map((call) => String(call[0])).join('')
			expect(said).toContain(`scheduled job ${job.name}`)
			expect(said).toContain(`cd ${job.folder.canonical} && namzu resume ${session}`)
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, 'NAMZU_HOME')
			else process.env.NAMZU_HOME = previous
			sb.cleanup()
		}
	})

	it('carries explicit binary provenance through the CLI to the TUI launch', async () => {
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
		const resumeCommand = ['/opt/node/bin/node', '/checkout/namzu/dist/bin.js'] as const
		await expect(
			runCli({
				argv: [
					'test-runner-node',
					'unrelated-script',
					'resume',
					'4aba553c-4222-48f2-8047-62a22f1f21d7',
				],
				resumeCommand,
			}),
		).resolves.toBe(0)
		expect(launchTui).toHaveBeenCalledWith(
			expect.objectContaining({ initialConversationId: '4aba553c-4222-48f2-8047-62a22f1f21d7' }),
			{ resumeCommand },
		)
	})
})
