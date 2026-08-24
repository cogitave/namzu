import { describe, expect, it } from 'vitest'

import { HostCallDeniedError, WorkerCodeRuntime } from '../index.js'
import type {
	CodeRunResult,
	CodeRuntime,
	HostCallContext,
	HostCallHandler,
	HostCallRequest,
	HostCallResult,
	RunCodeOptions,
} from '../index.js'

describe('the model-authored code seam is nameable from the package root', () => {
	it('exports the runtime values and every type in their public signatures', () => {
		const runtime: CodeRuntime = new WorkerCodeRuntime()
		const handler: HostCallHandler = async (
			_request: HostCallRequest,
			_context: HostCallContext,
		): Promise<HostCallResult> => ({ ok: true })
		const options = {
			source: 'return 1',
			allowedCalls: [],
			onHostCall: handler,
			timeoutMs: 1_000,
			maxOutputBytes: 1_024,
		} satisfies RunCodeOptions
		const result: CodeRunResult = {
			outcome: { status: 'completed', result: 1 },
			output: '',
			outputTruncated: false,
			calls: [],
		}

		expect(runtime.id).toBe('worker_threads')
		expect(options.onHostCall).toBe(handler)
		expect(result.outcome).toEqual({ status: 'completed', result: 1 })
		expect(new HostCallDeniedError({ name: 'write', allowed: [] }).name).toBe('HostCallDeniedError')
	})
})
