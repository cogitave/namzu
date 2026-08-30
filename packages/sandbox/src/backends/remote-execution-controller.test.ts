import { describe, expect, it } from 'vitest'

import {
	RemoteCancellationUnknownError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
} from './remote-execution-controller.js'

const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000001'

function reservation() {
	return {
		ok: true,
		protocolVersion: 2,
		executionId: EXECUTION_ID,
		leaseExpiresAt: Date.now() + 30_000,
	}
}

describe('RemoteExecutionController', () => {
	it('preserves truthful peer timeout metadata when observation races natural completion', async () => {
		const terminal = {
			exitCode: 0,
			stdout: 'done',
			stderr: '',
			timedOut: false,
			durationMs: 20,
		}
		const adapter: RemoteExecutionAdapter = {
			label: 'test peer',
			reserve: async () => reservation(),
			cancel: async () => ({
				ok: true,
				state: 'completed',
				started: true,
				result: terminal,
			}),
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20))
				return terminal
			},
		}
		const controller = new RemoteExecutionController(adapter, {
			executionObservationGraceMs: 1,
			resultDrainTimeoutMs: 100,
		})

		await expect(controller.exec('true', undefined, { timeout: 1 })).resolves.toMatchObject({
			timedOut: false,
			exitCode: 0,
		})
	})

	it('classifies a lost admitted execution with unconfirmed cancellation as unknown', async () => {
		const adapter: RemoteExecutionAdapter = {
			label: 'test peer',
			reserve: async () => reservation(),
			cancel: async () => {
				throw new Error('confirmation unavailable')
			},
			execute: async () => {
				throw new Error('data stream lost')
			},
		}
		const controller = new RemoteExecutionController(adapter, {
			controlRequestTimeoutMs: 5,
			cancelConfirmTimeoutMs: 20,
		})

		await expect(controller.exec('true', undefined, undefined)).rejects.toBeInstanceOf(
			RemoteCancellationUnknownError,
		)
	})
})
