import { describe, expect, it } from 'vitest'

import { LocalExecutionContext } from '../../execution/local.js'
import type { CommandResult } from '../../types/execution/index.js'
import { generateRunId } from '../../utils/id.js'
import { createCommandGate } from '../command-gate.js'

describe.skipIf(process.platform === 'win32')(
	'verification owns the actual process outcome',
	() => {
		it('refuses a timed-out shell whose TERM handler exits zero', async () => {
			const execution = new LocalExecutionContext({ id: 'gate-termination', cwd: process.cwd() })
			let receipt: CommandResult | undefined
			const gate = createCommandGate({
				commands: ["trap 'exit 0' TERM; while :; do sleep 1; done"],
				cwd: process.cwd(),
				timeoutMs: 250,
				fingerprint: async () => null,
				exec: async (command, args, options) => {
					receipt = await execution.executeCommand(command, args, options)
					return receipt
				},
			})
			const verdict = await gate('done', { runId: generateRunId(), iteration: 1, messages: [] })
			expect(receipt?.exitCode).toBe(0)
			expect(receipt?.termination).toMatchObject({ origin: 'timeout', admitted: true })
			expect(verdict.accept).toBe(false)
			if (!verdict.accept) expect(verdict.feedback).toContain('terminated: timeout')
		})
	},
)
