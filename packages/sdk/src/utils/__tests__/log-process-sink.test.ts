import { describe, expect, it, vi } from 'vitest'

async function freshInstallProcessSink() {
	vi.resetModules()
	const module = await import('../log/process-sink.js')
	return module.installProcessSink
}

describe('installProcessSink', () => {
	it('refuses a second call without { replace: true }', async () => {
		const installProcessSink = await freshInstallProcessSink()
		const sink = { emit() {} }

		installProcessSink(sink, 'info')

		expect(() => installProcessSink(sink, 'debug')).toThrow(/already called/)
	})

	it('accepts a second call when { replace: true } is passed', async () => {
		const installProcessSink = await freshInstallProcessSink()
		const sink = { emit() {} }

		installProcessSink(sink, 'info')

		expect(() => installProcessSink(sink, 'debug', { replace: true })).not.toThrow()
	})

	it('accepts the first call unconditionally, with no prior install to replace', async () => {
		const installProcessSink = await freshInstallProcessSink()
		const sink = { emit() {} }

		expect(() => installProcessSink(sink, 'info')).not.toThrow()
	})
})
