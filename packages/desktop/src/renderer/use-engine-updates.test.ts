import { describe, expect, it, vi } from 'vitest'
import type {
	EngineUpdateAnnouncement,
	EngineUpdateNotice,
	EngineUpdatesState,
} from '../shared/engine-update-protocol.js'
import { connectEngineUpdates } from './use-engine-updates.js'

const behind: EngineUpdatesState = {
	checking: false,
	items: [
		{
			id: 'codex-cli',
			name: 'Codex CLI',
			package: '@openai/codex',
			installed: '0.154.0',
			latest: '0.162.0',
			method: 'npm-global',
			status: 'available',
			runnable: true,
		},
	],
}
const quiet: EngineUpdatesState = { checking: false, items: [] }

function setup(announcements: EngineUpdateAnnouncement[] = []) {
	let push: (state: EngineUpdatesState) => void = () => undefined
	let notice: (value: EngineUpdateNotice) => void = () => undefined
	const stops = { state: vi.fn(), notice: vi.fn() }
	const claims = vi.fn(async () => announcements)
	const api = {
		engineUpdates: vi.fn(async () => quiet),
		onEngineUpdates: vi.fn((listener: (state: EngineUpdatesState) => void) => {
			push = listener
			return stops.state
		}),
		onEngineUpdateNotice: vi.fn((listener: (value: EngineUpdateNotice) => void) => {
			notice = listener
			return stops.notice
		}),
		claimEngineUpdateAnnouncements: claims,
	}
	const sink = { set: vi.fn(), notify: vi.fn(() => 'id'), openUpdates: vi.fn() }
	const stop = connectEngineUpdates(api, sink)
	return {
		api,
		sink,
		stop,
		stops,
		claims,
		push: (state: EngineUpdatesState) => push(state),
		notice: (value: EngineUpdateNotice) => notice(value),
	}
}

const flush = async () => {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('following main’s engine updates', () => {
	it('reads the state once and follows what is pushed', async () => {
		const t = setup()
		await flush()
		expect(t.sink.set).toHaveBeenCalledWith(quiet)
		t.push(behind)
		expect(t.sink.set).toHaveBeenLastCalledWith(behind)
	})

	it('asks for announcements only when something is behind, and toasts each once with an Update… action', async () => {
		const t = setup([{ id: 'codex-cli', name: 'Codex CLI', version: '0.162.0' }])
		await flush()
		expect(t.claims).not.toHaveBeenCalled()
		t.push(behind)
		await flush()
		expect(t.claims).toHaveBeenCalledTimes(1)
		expect(t.sink.notify).toHaveBeenCalledTimes(1)
		const [text, options] = t.sink.notify.mock.calls[0] as unknown as [
			string,
			{ tone: string; action: { label: string; onClick: () => void } },
		]
		expect(text).toBe('Codex CLI 0.162.0 is available')
		expect(options.tone).toBe('neutral')
		expect(options.action.label).toBe('Update…')
		options.action.onClick()
		expect(t.sink.openUpdates).toHaveBeenCalledTimes(1)
	})

	it('toasts nothing when main says another window already announced it', async () => {
		const t = setup([])
		t.push(behind)
		await flush()
		expect(t.claims).toHaveBeenCalledTimes(1)
		expect(t.sink.notify).not.toHaveBeenCalled()
	})

	it('shows the notices of an update the person started', async () => {
		const t = setup()
		t.notice({ text: 'Codex CLI updated to 0.162.0', tone: 'success' })
		t.notice({ text: 'Update failed — see the terminal', tone: 'error' })
		expect(t.sink.notify.mock.calls).toEqual([
			['Codex CLI updated to 0.162.0', { tone: 'success' }],
			['Update failed — see the terminal', { tone: 'error' }],
		])
	})

	it('stops listening, and a late answer after that changes nothing', async () => {
		const t = setup([{ id: 'codex-cli', name: 'Codex CLI', version: '0.162.0' }])
		t.push(behind)
		t.stop()
		await flush()
		expect(t.stops.state).toHaveBeenCalled()
		expect(t.stops.notice).toHaveBeenCalled()
		expect(t.sink.notify).not.toHaveBeenCalled()
		t.push(quiet)
		expect(t.sink.set).not.toHaveBeenCalledWith(quiet)
	})

	it('does nothing in a window whose build has no engine updates', () => {
		const sink = { set: vi.fn(), notify: vi.fn(() => 'id'), openUpdates: vi.fn() }
		expect(() => connectEngineUpdates({}, sink)()).not.toThrow()
		expect(sink.set).not.toHaveBeenCalled()
	})
})
